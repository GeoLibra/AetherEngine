use crate::{
    diagnostics::{error as cook_error, REFLECTION_FAILED},
    protocol::{
        CookBinding, CookBufferField, CookBufferLayout, CookDiagnostic, CookEntryPoint, CookStageIo,
    },
};
use naga::{
    proc::Layouter, valid::ModuleInfo, AddressSpace, ArraySize, Handle, ImageClass, ImageDimension,
    Module, Scalar, ScalarKind, ShaderStage, StorageAccess, Type, TypeInner, VectorSize,
};

/// Reflects canonical vertex inputs and fragment outputs from entry-point signatures.
pub fn reflect_stage_io(
    module: &Module,
) -> Result<(Vec<CookStageIo>, Vec<CookStageIo>), CookDiagnostic> {
    let mut vertex_inputs = Vec::new();
    let mut fragment_outputs = Vec::new();
    for entry in &module.entry_points {
        if entry.stage == ShaderStage::Vertex {
            for argument in &entry.function.arguments {
                collect_stage_io(
                    module,
                    argument.ty,
                    argument.binding.as_ref(),
                    argument.name.as_deref(),
                    &entry.name,
                    &mut vertex_inputs,
                )?;
            }
        }
        if entry.stage == ShaderStage::Fragment {
            if let Some(result) = entry.function.result.as_ref() {
                collect_stage_io(
                    module,
                    result.ty,
                    result.binding.as_ref(),
                    None,
                    &entry.name,
                    &mut fragment_outputs,
                )?;
            }
        }
    }
    vertex_inputs.sort_by_key(|value| (value.location, value.name.clone()));
    fragment_outputs.sort_by_key(|value| (value.location, value.name.clone()));
    Ok((vertex_inputs, fragment_outputs))
}

fn collect_stage_io(
    module: &Module,
    handle: Handle<Type>,
    binding: Option<&naga::Binding>,
    name: Option<&str>,
    entry_name: &str,
    output: &mut Vec<CookStageIo>,
) -> Result<(), CookDiagnostic> {
    if let Some(naga::Binding::Location { location, .. }) = binding {
        output.push(CookStageIo {
            location: *location,
            name: name.unwrap_or(entry_name).to_owned(),
            type_name: stable_type_name(module, handle).ok_or_else(reflection_error)?,
        });
        return Ok(());
    }
    if let TypeInner::Struct { members, .. } = &module.types[handle].inner {
        for member in members {
            collect_stage_io(
                module,
                member.ty,
                member.binding.as_ref(),
                member.name.as_deref(),
                entry_name,
                output,
            )?;
        }
    }
    Ok(())
}
/// Reflects deterministic WGSL member offsets from Naga's validated layout rules.
pub fn reflect_buffer_layouts(module: &Module) -> Result<Vec<CookBufferLayout>, CookDiagnostic> {
    let mut layouter = Layouter::default();
    layouter
        .update(module.to_ctx())
        .map_err(|_| reflection_error())?;
    let mut layouts = Vec::new();
    for (_, global) in module.global_variables.iter() {
        if !matches!(
            global.space,
            AddressSpace::Uniform | AddressSpace::Storage { .. }
        ) {
            continue;
        }
        let Some(resource) = global.binding.as_ref() else {
            continue;
        };
        let name = global.name.clone().ok_or_else(reflection_error)?;
        let root = layouter[global.ty];
        let mut fields = Vec::new();
        reflect_fields(module, &layouter, global.ty, "", 0, &mut fields)?;
        layouts.push(CookBufferLayout {
            group: resource.group,
            binding: resource.binding,
            name,
            byte_size: root.size,
            alignment: root.alignment * 1,
            fields,
        });
    }
    layouts.sort_by_key(|layout| (layout.group, layout.binding, layout.name.clone()));
    Ok(layouts)
}

fn reflect_fields(
    module: &Module,
    layouter: &Layouter,
    handle: Handle<Type>,
    prefix: &str,
    base_offset: u32,
    output: &mut Vec<CookBufferField>,
) -> Result<(), CookDiagnostic> {
    if let TypeInner::Struct { members, .. } = &module.types[handle].inner {
        for member in members {
            let name = member.name.as_ref().ok_or_else(reflection_error)?;
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}.{name}")
            };
            reflect_fields(
                module,
                layouter,
                member.ty,
                &path,
                base_offset + member.offset,
                output,
            )?;
        }
        return Ok(());
    }
    let layout = layouter[handle];
    output.push(CookBufferField {
        path: prefix.to_owned(),
        offset: base_offset,
        size: layout.size,
        alignment: layout
            .alignment
            .to_string()
            .parse()
            .map_err(|_| reflection_error())?,
        type_name: stable_type_name(module, handle).ok_or_else(reflection_error)?,
    });
    Ok(())
}

#[allow(clippy::result_large_err)] // Diagnostics are the stable protocol error value, not a hot path.
/// Reflects validated WGSL resources into deterministic cooker-owned records.
///
/// The caller must supply `ModuleInfo` produced by validating the same module.
/// Bound resource kinds that the canonical P1 schema cannot represent fail closed.
pub fn reflect_module(
    module: &Module,
    info: &ModuleInfo,
) -> Result<(Vec<CookEntryPoint>, Vec<CookBinding>), CookDiagnostic> {
    let mut reflected_globals = Vec::new();
    for (handle, global) in module.global_variables.iter() {
        let Some(resource_binding) = global.binding.as_ref() else {
            continue;
        };
        let reflected = reflect_binding(
            module,
            global,
            resource_binding.group,
            resource_binding.binding,
        )?;
        reflected_globals.push((handle, reflected));
    }
    reflected_globals.sort_by(|(_, left), (_, right)| binding_key(left).cmp(&binding_key(right)));

    let bindings = reflected_globals
        .iter()
        .map(|(_, binding)| binding.clone())
        .collect();
    let mut entries = module
        .entry_points
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let usage = info.get_entry_point(index);
            let bindings = reflected_globals
                .iter()
                .filter(|(handle, _)| !usage[*handle].is_empty())
                .map(|(_, binding)| binding.clone())
                .collect();
            CookEntryPoint {
                name: entry.name.clone(),
                stage: stage_name(entry.stage).to_owned(),
                bindings,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        stage_rank(&left.stage)
            .cmp(&stage_rank(&right.stage))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok((entries, bindings))
}

#[allow(clippy::result_large_err)] // Diagnostics are the stable protocol error value, not a hot path.
fn reflect_binding(
    module: &Module,
    global: &naga::GlobalVariable,
    group: u32,
    binding: u32,
) -> Result<CookBinding, CookDiagnostic> {
    let ty = &module.types[global.ty];
    let (kind, address_space, access) = match (&global.space, &ty.inner) {
        (AddressSpace::Uniform, _) => ("uniform-buffer", "uniform", "read"),
        (AddressSpace::Storage { access }, _) => (
            "storage-buffer",
            "storage",
            if access.contains(StorageAccess::STORE) {
                "read-write"
            } else {
                "read"
            },
        ),
        (
            AddressSpace::Handle,
            TypeInner::Image {
                class: ImageClass::Sampled { .. } | ImageClass::Depth { .. },
                ..
            },
        ) => ("texture", "handle", "read"),
        (AddressSpace::Handle, TypeInner::Sampler { comparison: false }) => {
            ("sampler", "handle", "read")
        }
        (AddressSpace::Handle, TypeInner::Sampler { comparison: true }) => {
            ("comparison-sampler", "handle", "read")
        }
        _ => return Err(reflection_error()),
    };
    let name = global.name.clone().ok_or_else(reflection_error)?;
    let type_name = stable_type_name(module, global.ty).ok_or_else(reflection_error)?;

    Ok(CookBinding {
        group,
        binding,
        name,
        kind: kind.to_owned(),
        address_space: address_space.to_owned(),
        access: access.to_owned(),
        type_name,
    })
}

fn stable_type_name(module: &Module, handle: Handle<Type>) -> Option<String> {
    let ty = &module.types[handle];
    if let Some(name) = ty.name.as_ref() {
        return Some(name.clone());
    }
    match &ty.inner {
        TypeInner::Scalar(scalar) => scalar_name(*scalar).map(str::to_owned),
        TypeInner::Vector { size, scalar } => Some(format!(
            "vec{}<{}>",
            vector_size(*size),
            scalar_name(*scalar)?
        )),
        TypeInner::Matrix {
            columns,
            rows,
            scalar,
        } => Some(format!(
            "mat{}x{}<{}>",
            vector_size(*columns),
            vector_size(*rows),
            scalar_name(*scalar)?
        )),
        TypeInner::Array { base, size, .. } => match size {
            ArraySize::Constant(length) => Some(format!(
                "array<{},{}>",
                stable_type_name(module, *base)?,
                length
            )),
            ArraySize::Dynamic => Some(format!("array<{}>", stable_type_name(module, *base)?)),
            ArraySize::Pending(_) => None,
        },
        TypeInner::Image {
            dim,
            arrayed,
            class,
        } => image_type_name(*dim, *arrayed, *class),
        TypeInner::Sampler { comparison } => Some(if *comparison {
            "sampler_comparison".to_owned()
        } else {
            "sampler".to_owned()
        }),
        _ => None,
    }
}

fn image_type_name(dim: ImageDimension, arrayed: bool, class: ImageClass) -> Option<String> {
    let dimension = match (dim, arrayed) {
        (ImageDimension::D1, false) => "1d",
        (ImageDimension::D2, false) => "2d",
        (ImageDimension::D2, true) => "2d_array",
        (ImageDimension::D3, false) => "3d",
        (ImageDimension::Cube, false) => "cube",
        (ImageDimension::Cube, true) => "cube_array",
        _ => return None,
    };
    match class {
        ImageClass::Sampled { kind, multi } => {
            let prefix = if multi {
                "texture_multisampled"
            } else {
                "texture"
            };
            Some(format!("{prefix}_{dimension}<{}>", scalar_kind_name(kind)?))
        }
        ImageClass::Depth { multi } => {
            let prefix = if multi {
                "texture_depth_multisampled"
            } else {
                "texture_depth"
            };
            Some(format!("{prefix}_{dimension}"))
        }
        ImageClass::Storage { .. } | ImageClass::External => None,
    }
}

fn scalar_name(scalar: Scalar) -> Option<&'static str> {
    let width = scalar.width;
    match (scalar.kind, width) {
        (ScalarKind::Float, 2) => Some("f16"),
        (ScalarKind::Float, 4) => Some("f32"),
        (ScalarKind::Float, 8) => Some("f64"),
        (ScalarKind::Sint, 4) => Some("i32"),
        (ScalarKind::Uint, 4) => Some("u32"),
        (ScalarKind::Bool, _) => Some("bool"),
        _ => None,
    }
}

fn scalar_kind_name(kind: ScalarKind) -> Option<&'static str> {
    match kind {
        ScalarKind::Float => Some("f32"),
        ScalarKind::Sint => Some("i32"),
        ScalarKind::Uint => Some("u32"),
        ScalarKind::Bool | ScalarKind::AbstractInt | ScalarKind::AbstractFloat => None,
    }
}

fn vector_size(size: VectorSize) -> u8 {
    size.into()
}

fn stage_name(stage: ShaderStage) -> &'static str {
    match stage {
        ShaderStage::Vertex => "vertex",
        ShaderStage::Fragment => "fragment",
        ShaderStage::Compute => "compute",
        ShaderStage::Task => "task",
        ShaderStage::Mesh => "mesh",
        ShaderStage::RayGeneration => "ray-generation",
        ShaderStage::Miss => "miss",
        ShaderStage::AnyHit => "any-hit",
        ShaderStage::ClosestHit => "closest-hit",
    }
}

fn stage_rank(stage: &str) -> u8 {
    match stage {
        "vertex" => 0,
        "fragment" => 1,
        "compute" => 2,
        "task" => 3,
        "mesh" => 4,
        "ray-generation" => 5,
        "miss" => 6,
        "any-hit" => 7,
        "closest-hit" => 8,
        _ => u8::MAX,
    }
}

fn binding_key(binding: &CookBinding) -> (u32, u32, &str) {
    (binding.group, binding.binding, &binding.name)
}

fn reflection_error() -> CookDiagnostic {
    let mut diagnostic = cook_error(
        REFLECTION_FAILED,
        "WGSL resource cannot be represented by the canonical reflection schema",
        "",
    );
    diagnostic.backend_stage = Some("reflection".to_owned());
    diagnostic
}

#[cfg(test)]
mod tests {
    use super::{reflect_buffer_layouts, reflect_module, reflect_stage_io};
    use crate::protocol::{CookBinding, CookEntryPoint};
    use naga::{
        front::wgsl,
        valid::{Capabilities, ValidationFlags, Validator},
    };

    const FIXTURE: &str = include_str!("../corpus/reflection.wgsl");

    fn reflected_fixture() -> (Vec<CookEntryPoint>, Vec<CookBinding>) {
        let module = wgsl::parse_str(FIXTURE).unwrap();
        let info = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&module)
            .unwrap();
        reflect_module(&module, &info).unwrap()
    }

    fn binding(
        group: u32,
        binding: u32,
        name: &str,
        kind: &str,
        address_space: &str,
        access: &str,
        type_name: &str,
    ) -> CookBinding {
        CookBinding {
            group,
            binding,
            name: name.to_owned(),
            kind: kind.to_owned(),
            address_space: address_space.to_owned(),
            access: access.to_owned(),
            type_name: type_name.to_owned(),
        }
    }

    #[test]
    fn reflects_canonical_bindings_and_only_each_entry_points_used_globals() {
        let (entries, bindings) = reflected_fixture();
        let expected_bindings = vec![
            binding(
                0,
                0,
                "scene",
                "uniform-buffer",
                "uniform",
                "read",
                "SceneUniforms",
            ),
            binding(
                0,
                1,
                "offsets",
                "storage-buffer",
                "storage",
                "read",
                "array<vec4<f32>>",
            ),
            binding(
                1,
                0,
                "colorTexture",
                "texture",
                "handle",
                "read",
                "texture_2d<f32>",
            ),
            binding(
                1,
                1,
                "depthTexture",
                "texture",
                "handle",
                "read",
                "texture_depth_2d",
            ),
            binding(1, 2, "colorSampler", "sampler", "handle", "read", "sampler"),
            binding(
                1,
                3,
                "shadowSampler",
                "comparison-sampler",
                "handle",
                "read",
                "sampler_comparison",
            ),
        ];
        let expected_entries = vec![
            CookEntryPoint {
                name: "vertexMain".to_owned(),
                stage: "vertex".to_owned(),
                bindings: expected_bindings[0..2].to_vec(),
            },
            CookEntryPoint {
                name: "fragmentMain".to_owned(),
                stage: "fragment".to_owned(),
                bindings: expected_bindings[2..6].to_vec(),
            },
        ];

        assert_eq!(bindings, expected_bindings);
        assert_eq!(entries, expected_entries);
    }

    #[test]
    fn reflection_serialization_is_byte_deterministic() {
        let first = reflected_fixture();
        let second = reflected_fixture();

        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
    }

    #[test]
    fn reflects_uniform_buffer_member_offsets_sizes_and_alignment() {
        let module = wgsl::parse_str(FIXTURE).unwrap();
        let layouts = reflect_buffer_layouts(&module).unwrap();
        let scene = layouts
            .iter()
            .find(|layout| layout.name == "scene")
            .expect("scene uniform layout");

        assert_eq!(scene.byte_size, 80);
        assert_eq!(scene.alignment, 16);
        assert_eq!(scene.fields[0].path, "transform");
        assert_eq!(scene.fields[0].offset, 0);
        assert_eq!(scene.fields[0].size, 64);
        assert_eq!(scene.fields[1].path, "material.tint");
        assert_eq!(scene.fields[1].offset, 64);
        assert_eq!(scene.fields[1].size, 16);
    }

    #[test]
    fn reflects_vertex_inputs_and_fragment_outputs() {
        let module = wgsl::parse_str(FIXTURE).unwrap();
        let (vertex_inputs, fragment_outputs) = reflect_stage_io(&module).unwrap();
        assert_eq!(
            vertex_inputs
                .iter()
                .map(|value| (
                    value.location,
                    value.name.as_str(),
                    value.type_name.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![(0, "position", "vec3<f32>"), (1, "uv", "vec2<f32>"),]
        );
        assert_eq!(
            fragment_outputs
                .iter()
                .map(|value| (
                    value.location,
                    value.name.as_str(),
                    value.type_name.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![(0, "fragmentMain", "vec4<f32>"),]
        );
    }
}
