export type ShaderTypeId = string & { readonly __shaderTypeId: unique symbol };
export type ShaderSymbolId = number & { readonly __shaderSymbolId: unique symbol };
export type ShaderFunctionId = number & { readonly __shaderFunctionId: unique symbol };
