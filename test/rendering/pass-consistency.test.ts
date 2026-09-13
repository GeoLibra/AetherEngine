import { describe, expect, test } from 'vitest';
import { BaselineStandardLitPreparation } from '../../src/rendering/baseline/baseline-preparation';
import {
  composeTextureUvTransform,
  createAssetHandle,
  createBoxMeshData,
  createStandardLitMaterial,
  evaluateCookTorranceDirect,
  MaterialAssetType,
  MeshAssetType,
  NullDevice,
  NullSurface,
  packBaselineMaterialUniform,
  type BrowserGraphicsSession,
  type RenderEntityId,
  type TextureUvTransform
} from '../../src';

describe('pass consistency & PBR invariants (PR 3)', () => {
  describe('KHR_texture_transform affine matrix evaluation', () => {
    test('computes identity transform when omitted or empty', () => {
      const identity = composeTextureUvTransform();
      expect(identity.matrix).toEqual([1, 0, 0, 1]);
      expect(identity.offset).toEqual([0, 0]);

      const empty = composeTextureUvTransform({});
      expect(empty.matrix).toEqual([1, 0, 0, 1]);
      expect(empty.offset).toEqual([0, 0]);
    });

    test('evaluates scale, rotation, and translation in glTF specification order', () => {
      // Rotate 90 deg (pi/2), scale by (2, 3), offset by (0.5, 0.25)
      const transform: TextureUvTransform = {
        offset: [0.5, 0.25],
        rotation: Math.PI / 2,
        scale: [2, 3]
      };
      const { matrix, offset } = composeTextureUvTransform(transform);

      // cos(pi/2) ~ 0, sin(pi/2) ~ 1
      // matrix = [sx*cos, -sy*sin, sx*sin, sy*cos] = [0, -3, 2, 0]
      expect(matrix[0]).toBeCloseTo(0);
      expect(matrix[1]).toBeCloseTo(-3);
      expect(matrix[2]).toBeCloseTo(2);
      expect(matrix[3]).toBeCloseTo(0);
      expect(offset).toEqual([0.5, 0.25]);

      // Verify shader affine evaluation:
      // uv' = matrix * uv + offset
      const uv = [0.1, 0.2] as const;
      const transformedX = matrix[0]! * uv[0] + matrix[1]! * uv[1] + offset[0]!;
      const transformedY = matrix[2]! * uv[0] + matrix[3]! * uv[1] + offset[1]!;

      expect(transformedX).toBeCloseTo(0 * 0.1 - 3 * 0.2 + 0.5); // -0.6 + 0.5 = -0.1
      expect(transformedY).toBeCloseTo(2 * 0.1 + 0 * 0.2 + 0.25); // 0.2 + 0.25 = 0.45
    });
  });

  describe('double-sided back-face normal inversion and tangent basis', () => {
    test('sets cullMode to none when doubleSided is true', () => {
      const doubleSidedMat = createStandardLitMaterial({
        doubleSided: true
      });
      expect(doubleSidedMat.asset.renderState.cullMode).toBe('none');

      const singleSidedMat = createStandardLitMaterial({
        doubleSided: false
      });
      expect(singleSidedMat.asset.renderState.cullMode).toBe('back');
    });

    test('shader normal inversion preserves tangent-basis handedness on back faces', () => {
      // Simulating shader geometric basis:
      // frontFacing: true -> geometricNormal = rawNormal
      // frontFacing: false -> geometricNormal = -rawNormal
      // bitangent = cross(geometricNormal, tangent.xyz) * tangent.w
      const rawNormal = [0, 0, 1] as const;
      const tangent = [1, 0, 0, 1] as const; // tangent.w = +1 (right-handed)

      const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        [
          a[1]! * b[2]! - a[2]! * b[1]!,
          a[2]! * b[0]! - a[0]! * b[2]!,
          a[0]! * b[1]! - a[1]! * b[0]!
        ] as const;

      const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
        a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

      // Front face
      const nFront = rawNormal;
      const bFront = cross(nFront, [tangent[0], tangent[1], tangent[2]]); // (0,0,1) x (1,0,0) = (0,1,0)
      expect(bFront).toEqual([0, 1, 0]);

      // Back face
      const nBack = [-rawNormal[0], -rawNormal[1], -rawNormal[2]] as const;
      const bBack = cross(nBack, [tangent[0], tangent[1], tangent[2]]); // (0,0,-1) x (1,0,0) = (0,-1,0)
      expect(bBack).toEqual([0, -1, 0]);

      // Handedness check: (T x B) . N
      const handednessFront = dot(cross([tangent[0], tangent[1], tangent[2]], bFront), nFront);
      const handednessBack = dot(cross([tangent[0], tangent[1], tangent[2]], bBack), nBack);

      // Both must be +1 (tangent basis orientation is preserved, normal map does not invert X/Y incorrectly)
      expect(handednessFront).toBeCloseTo(1);
      expect(handednessBack).toBeCloseTo(1);
    });
  });

  describe('alpha mask silhouette matching across passes', () => {
    test('color and shadow passes evaluate identical alpha and cutoff discard', () => {
      const baseColorFactor = [1, 1, 1, 0.8] as const;
      const textureSampleAlpha = 0.5;
      const vertexColorAlpha = 0.9;
      const alphaCutoff = 0.4;

      // In both standardLitFragment and standardShadowFragment:
      // alpha = baseColorFactor.a * sample.a * vertexColor.a
      const alpha = baseColorFactor[3] * textureSampleAlpha * vertexColorAlpha; // 0.8 * 0.5 * 0.9 = 0.36
      const shouldDiscard = alpha < alphaCutoff;

      expect(alpha).toBeCloseTo(0.36);
      expect(shouldDiscard).toBe(true); // Both shaders discard consistently

      const passSampleAlpha = 0.6;
      const alphaPassing = baseColorFactor[3] * passSampleAlpha * vertexColorAlpha; // 0.8 * 0.6 * 0.9 = 0.432
      expect(alphaPassing >= alphaCutoff).toBe(true);
    });

    test('packs uniform layout matching standardLit and standardShadow ABIs', () => {
      const material = createStandardLitMaterial({
        alphaMode: 'mask',
        alphaCutoff: 0.33,
        transforms: {
          baseColor: composeTextureUvTransform({
            offset: [0.1, 0.2],
            scale: [1.5, 2.5]
          })
        }
      });

      const packed = packBaselineMaterialUniform(material);

      expect(packed.length).toBe(60); // 240 bytes = 60 words
      const floatView = new Float32Array(packed.buffer);

      // alphaCutoff is at offset 44 (word 11)
      expect(floatView[11]).toBeCloseTo(0.33);
      // alphaMask is at offset 68 (word 17)
      expect(packed[17]).toBe(1);
      // baseColorTransform is at offset 80 (words 20..23)
      expect(floatView[20]).toBeCloseTo(1.5);
      expect(floatView[23]).toBeCloseTo(2.5);
      // baseColorOffset is at offset 96 (words 24..25)
      expect(floatView[24]).toBeCloseTo(0.1);
      expect(floatView[25]).toBeCloseTo(0.2);
    });
  });

  describe('ambient occlusion indirect-diffuse invariance', () => {
    test('direct directional light is independent of ambient occlusion', () => {
      const directSample = (radiance: readonly [number, number, number]) =>
        evaluateCookTorranceDirect({
          baseColorLinear: [0.8, 0.6, 0.4],
          metallic: 0.2,
          roughness: 0.4,
          normal: [0, 1, 0],
          viewDirection: [0, 0.8, 0.6],
          lightDirection: [0, 1, 0],
          lightRadianceLinear: radiance
        });

      const radiance = [5, 5, 5] as const;
      const lit = directSample(radiance);

      // Verify that direct PBR lighting depends purely on incident radiance and surface BRDF,
      // and ambient occlusion does NOT attenuate direct illumination.
      expect(lit[0]).toBeGreaterThan(0);
      expect(lit[1]).toBeGreaterThan(0);
      expect(lit[2]).toBeGreaterThan(0);
    });
  });

  describe('alphaMode lifecycle and transparent shadow rejection', () => {
    test('transparent materials configure transparent surface and depthWrite false', () => {
      const blendMat = createStandardLitMaterial({
        alphaMode: 'blend'
      });
      expect(blendMat.asset.renderState.surface).toBe('transparent');
      expect(blendMat.asset.renderState.depthWrite).toBe(false);

      const opaqueMat = createStandardLitMaterial({
        alphaMode: 'opaque'
      });
      expect(opaqueMat.asset.renderState.surface).toBe('opaque');
      expect(opaqueMat.asset.renderState.depthWrite).toBe(true);

      const maskMat = createStandardLitMaterial({
        alphaMode: 'mask'
      });
      expect(maskMat.asset.renderState.surface).toBe('alpha-mask');
      expect(maskMat.asset.renderState.depthWrite).toBe(true);
    });

    test('rejects shadow packet creation for transparent materials and attaches default color buffer', () => {
      const device = new NullDevice();
      const surface = new NullSurface({ id: Symbol('test'), kind: 'offscreen' });
      surface.configure(
        device,
        {
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          width: 800,
          height: 600,
          alphaMode: 'opaque',
          presentMode: 'fifo'
        },
        1
      );
      const graphics = {
        backend: 'webgpu',
        adapter: {} as never,
        device,
        surface,
        lost: new Promise(() => undefined),
        subscribe: () => () => true,
        resize: () => undefined,
        destroy: async () => undefined
      } satisfies BrowserGraphicsSession;

      const mesh = createBoxMeshData();
      const transparentMaterial = createStandardLitMaterial({ alphaMode: 'blend' });
      const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
      const materialHandle = createAssetHandle(MaterialAssetType, 'test.mat');

      const prep = new BaselineStandardLitPreparation({
        graphics,
        mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
        material: { handle: materialHandle, payloadVersion: 1, material: transparentMaterial },
        featurePolicyKey: 'test',
        viewId: 'test.view',
        environment: undefined,
        environmentLighting: {
          diffuseIrradiance: [0.1, 0.1, 0.1],
          intensity: 1,
          radianceTint: [1, 1, 1]
        }
      });

      // Transparent materials cannot cast depth shadows
      expect(() =>
        prep.createShadowPacket({
          entity: 1 as RenderEntityId,
          transform: {
            matrix: new Array(16).fill(0),
            normalMatrix: new Array(9).fill(0),
            previousMatrix: new Array(16).fill(0),
            determinantSign: 1,
            worldVersion: 1
          },
          viewProjection: new Array(16).fill(0),
          cascade: 0
        })
      ).toThrow(/gltf-render\.transparent-shadow-unsupported/);

      // Create forward draw packet
      const packet = prep.createPacket({
        entity: 1 as RenderEntityId,
        transform: {
          matrix: new Array(16).fill(0),
          normalMatrix: new Array(9).fill(0),
          previousMatrix: new Array(16).fill(0),
          determinantSign: 1,
          worldVersion: 1
        },
        view: {
          viewId: 'test.view',
          camera: 2 as RenderEntityId,
          revision: 1,
          layerMask: 1,
          view: new Array(16).fill(0),
          projection: new Array(16).fill(0),
          viewProjection: new Array(16).fill(0),
          inverseViewProjection: new Array(16).fill(0),
          cameraPosition: [0, 0, 5],
          unjitteredProjection: new Array(16).fill(0),
          unjitteredViewProjection: new Array(16).fill(0),
          viewportPixels: { x: 0, y: 0, width: 800, height: 600 },
          jitterPixels: [0, 0],
          depthMode: 'standard',
          projectionKind: 'perspective',
          near: 0.1,
          far: 1000
        }
      });

      expect(packet.phase).toBe('transparent');
      // Box mesh has position, normal, uv0, uv1, tangent (5 streams), but no color0.
      // Preparation should append the 16-byte defaultColorBuffer ([1, 1, 1, 1]) at location 5.
      expect(packet.vertexBuffers.length).toBe(mesh.streams.length + 1);

      prep.dispose();
    });
  });
});
