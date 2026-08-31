import type {
  FluxAttribute,
  FluxDeclarationNode,
  FluxExpressionNode,
  FluxFunctionNode,
  FluxGlobalNode,
  FluxModuleNode,
  FluxParameterNode,
  FluxStatementNode,
  FluxStructNode,
  FluxSwitchCaseNode,
  FluxTypeNode,
  FluxVariantNode
} from '../types';
import { lexFluxSource, type FluxToken } from './lexer';
import { spanAt } from './source-resolver';
import { lowerFluxModules } from './typecheck';
import { IExpressionParserHost, parseExpression } from './parser-expr';
import type {
  ResolvedShaderSource,
  ShaderDiagnostic,
  ShaderModuleIR,
  ShaderSourceModule,
  SourceSpan
} from '../types';

const NO_ATTRIBUTES: readonly FluxAttribute[] = Object.freeze([]);
const NO_CONTINUING_STATEMENTS: readonly FluxStatementNode[] = Object.freeze([]);
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

export interface ShaderParseResult {
  readonly ir?: ShaderModuleIR;
  readonly diagnostics: readonly ShaderDiagnostic[];
}

/**
 * Entry point for parsing FluxSL code.
 * Lexes each module, parses them using the FluxParser class, and performs lowered typechecking.
 */
export function parseFluxShader(closure: ResolvedShaderSource): ShaderParseResult {
  const diagnostics: ShaderDiagnostic[] = [];
  if (closure.root.languageVersion !== 1)
    diagnostics.push(
      diagnostic(
        'FLUX_UNSUPPORTED_VERSION',
        `Unsupported FluxSL language version ${closure.root.languageVersion}.`,
        firstSpan(closure)
      )
    );
  const modules: FluxModuleNode[] = [];
  for (const sourceModule of closure.modules) {
    const lexed = lexFluxSource(sourceModule.uri, sourceModule.content);
    diagnostics.push(...lexed.diagnostics);
    if (lexed.diagnostics.length > 0) continue;
    try {
      modules.push(new FluxParser(sourceModule, lexed.tokens).parseModule());
    } catch (error) {
      if (error instanceof FluxParseFailure) diagnostics.push(error.diagnostic);
      else throw error;
    }
  }
  if (diagnostics.length > 0) return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
  return lowerFluxModules(modules, closure.hash);
}

/**
 * Custom error class to signal recursive descent parsing failures
 * and cleanly bubble diagnostic errors out of helper methods.
 */
class FluxParseFailure extends Error {
  constructor(readonly diagnostic: ShaderDiagnostic) {
    super(diagnostic.message);
  }
}

/**
 * A LL(1) recursive-descent parser for the FluxSL grammar.
 * Translates FluxToken lists into AST nodes defined in types/ast.ts.
 */
class FluxParser implements IExpressionParserHost {
  public index = 0;
  constructor(
    private readonly module: ShaderSourceModule,
    public readonly tokens: readonly FluxToken[]
  ) {}

  // Frontend AST values are consumed synchronously by lowerFluxModules() and never
  // escape parseFluxShader(). Source spans and the resulting typed IR retain their
  // own public snapshot boundaries, so these owner-private parser records stay mutable.

  /**
   * Main parsing loop to construct a FluxModuleNode.
   * Parses top-level elements: includes, imports, variants, structs, globals, and functions.
   */
  parseModule(): FluxModuleNode {
    const declarations: FluxDeclarationNode[] = [];
    while (!this.at('eof')) {
      if (this.at('@') && (this.peek(1).text === 'include' || this.peek(1).text === 'import')) {
        this.consume();
        this.consume();
        this.expectKind('string');
        this.expect(';');
        continue;
      }
      if (this.at('@') && this.peek(1).text === 'variant') {
        declarations.push(this.parseVariant());
        continue;
      }
      const attributes = this.parseAttributes();
      if (this.at('struct')) declarations.push(this.parseStruct());
      else if (this.at('var')) declarations.push(this.parseGlobal(attributes));
      else if (this.at('fn')) declarations.push(this.parseFunction(attributes));
      else this.unsupported(`Unsupported top-level declaration "${this.current().text}".`);
    }
    return { uri: this.module.uri, declarations };
  }

  private parseVariant(): FluxVariantNode {
    const start = this.expect('@');
    this.expect('variant');
    const name = this.expectIdentifier();
    this.expect(':');
    const kind = this.expectIdentifier();
    const values: string[] = [];
    if (kind.text === 'enum') {
      this.expect('(');
      do values.push(this.expectIdentifier().text);
      while (this.match(','));
      this.expect(')');
    } else if (kind.text !== 'bool')
      this.unsupported(`Unsupported variant type "${kind.text}".`, kind);
    this.expect('=');
    const fallbackToken = this.consume();
    if (fallbackToken.kind !== 'identifier' && fallbackToken.kind !== 'number')
      this.unexpected('Expected variant fallback.', fallbackToken);
    const end = this.expect(';');
    const fallback =
      fallbackToken.text === 'true'
        ? true
        : fallbackToken.text === 'false'
          ? false
          : kind.text === 'enum'
            ? fallbackToken.text
            : Number(fallbackToken.text);
    return {
      kind: 'variant',
      name: name.text,
      variantKind: kind.text === 'bool' ? 'boolean' : 'enum',
      values,
      fallback,
      span: this.span(start, end)
    };
  }

  private parseStruct(): FluxStructNode {
    const start = this.expect('struct');
    const name = this.expectIdentifier();
    this.expect('{');
    const fields: FluxStructNode['fields'][number][] = [];
    while (!this.at('}')) {
      if (this.at('eof')) this.unexpectedEof('Unterminated struct declaration.');
      const attributes = this.parseAttributes();
      const field = this.expectIdentifier();
      if (!this.match(':'))
        throw new FluxParseFailure(
          diagnostic(
            'FLUX_MALFORMED_STRUCT',
            `Struct field "${field.text}" is missing a type separator.`,
            field.span
          )
        );
      const type = this.parseType();
      const end = this.current();
      if (!this.at('}') && !this.match(',') && !this.match(';'))
        this.unexpected('Expected "," or ";" after struct field.');
      fields.push({ name: field.text, type, attributes, span: this.span(field, end) });
    }
    this.expect('}');
    const end = this.expect(';');
    return {
      kind: 'struct',
      name: name.text,
      fields,
      span: this.span(start, end)
    };
  }

  private parseGlobal(attributes: readonly FluxAttribute[]): FluxGlobalNode {
    const start = this.expect('var');
    let addressSpace = 'handle';
    let access = 'read';
    if (this.match('<')) {
      addressSpace = this.expectIdentifier().text;
      if (this.match(',')) access = this.expectIdentifier().text;
      this.expect('>');
    }
    const name = this.expectIdentifier();
    this.expect(':');
    const type = this.parseType();
    const end = this.expect(';');
    return {
      kind: 'global',
      name: name.text,
      type,
      addressSpace,
      access,
      attributes,
      span: this.span(start, end)
    };
  }

  private parseFunction(attributes: readonly FluxAttribute[]): FluxFunctionNode {
    const start = this.expect('fn');
    const name = this.expectIdentifier();
    this.expect('(');
    const parameters: FluxParameterNode[] = [];
    while (!this.at(')')) {
      const parameterStart = this.current();
      const parameterAttributes = this.parseAttributes();
      const parameterName = this.expectIdentifier();
      this.expect(':');
      const type = this.parseType();
      parameters.push({
        name: parameterName.text,
        type,
        attributes: parameterAttributes,
        span: this.span(parameterStart, this.previous())
      });
      if (!this.match(',')) break;
    }
    this.expect(')');
    let returnType: FluxTypeNode | undefined;
    let returnAttributes: readonly FluxAttribute[] = NO_ATTRIBUTES;
    if (this.match('->')) {
      returnAttributes = this.parseAttributes();
      returnType = this.parseType();
    }
    const body = this.parseBlock();
    const stage = attributes.find(
      (attribute) =>
        attribute.name === 'vertex' || attribute.name === 'fragment' || attribute.name === 'compute'
    )?.name as FluxFunctionNode['stage'];
    return {
      kind: 'function',
      name: name.text,
      parameters,
      ...(returnType ? { returnType } : {}),
      returnAttributes,
      body,
      ...(stage ? { stage } : {}),
      span: this.span(start, this.previous())
    };
  }

  private parseAttributes(): readonly FluxAttribute[] {
    const attributes: FluxAttribute[] = [];
    while (this.at('@')) {
      const start = this.consume();
      const name = this.expectIdentifier();
      let value: number | string | undefined;
      let end = name;
      if (this.match('(')) {
        if (['vertex', 'fragment', 'compute'].includes(name.text))
          this.unexpected(`Attribute @${name.text} does not accept arguments.`);
        const token = this.consume();
        if (token.kind !== 'number' && token.kind !== 'identifier')
          this.unexpected(`Attribute @${name.text} requires a numeric or identifier value.`, token);
        if (name.text === 'builtin' && (token.kind !== 'identifier' || token.text !== 'position'))
          this.unsupported(`Unsupported shader built-in "${token.text}".`, token);
        if (name.text !== 'builtin' && token.kind !== 'number')
          this.unsupported(`Attribute @${name.text} requires a numeric value.`, token);
        value = token.kind === 'number' ? Number(token.text.replace(/[uif]$/, '')) : token.text;
        end = this.expect(')');
      } else if (['builtin', 'location', 'group', 'binding'].includes(name.text)) {
        this.unexpected(`Attribute @${name.text} requires a value enclosed in parentheses.`);
      }
      attributes.push({
        name: name.text,
        ...(value === undefined ? {} : { value }),
        span: this.span(start, end)
      });
    }
    return attributes;
  }

  parseType(): FluxTypeNode {
    const start = this.expectIdentifier();
    let name = start.text;
    let end = start;
    if (this.match('<')) {
      const arguments_: string[] = [];
      while (!this.at('>')) {
        if (this.at('eof')) this.unexpectedEof('Unterminated type argument list.');
        if (this.current().kind === 'number')
          arguments_.push(this.consume().text.replace(/[uif]$/, ''));
        else arguments_.push(this.parseType().name);
        if (!this.match(',')) break;
      }
      end = this.expect('>');
      name += `<${arguments_.join(',')}>`;
    }
    return { name, span: this.span(start, end) };
  }

  private parseBlock(): readonly FluxStatementNode[] {
    this.expect('{');
    const statements: FluxStatementNode[] = [];
    while (!this.at('}')) {
      if (this.at('eof')) this.unexpectedEof('Unterminated statement block.');
      statements.push(this.parseStatement());
    }
    this.expect('}');
    return statements;
  }

  private parseStatement(): FluxStatementNode {
    if (this.at('let') || this.at('var')) return this.parseDeclarationStatement();
    if (this.at('if')) return this.parseIf();
    if (this.at('switch')) return this.parseSwitch();
    if (this.at('loop')) return this.parseLoop();
    if (this.at('while')) return this.parseWhile();
    if (this.at('return')) return this.parseReturn();
    if (this.at('break') || this.at('continue') || this.at('discard')) {
      const keyword = this.consume();
      const end = this.expect(';');
      return {
        kind: keyword.text as 'break' | 'continue' | 'discard',
        span: this.span(keyword, end)
      };
    }
    if (this.at('for') || this.at('{') || this.at('continuing'))
      this.unsupported(`Unsupported statement "${this.current().text}".`);
    const expression = parseExpression(this);
    if (this.match('=')) {
      const value = parseExpression(this);
      const end = this.expect(';');
      return {
        kind: 'assign',
        target: expression,
        value,
        span: this.spanFrom(expression.span, end)
      };
    }
    const end = this.expect(';');
    return {
      kind: 'expression',
      expression,
      span: this.spanFrom(expression.span, end)
    };
  }

  private parseDeclarationStatement(): FluxStatementNode {
    const start = this.consume();
    const name = this.expectIdentifier();
    let type: FluxTypeNode | undefined;
    let value: FluxExpressionNode | undefined;
    if (this.match(':')) type = this.parseType();
    if (this.match('=')) value = parseExpression(this);
    if (!type && !value) this.unexpected('A declaration requires a type or initializer.', name);
    const end = this.expect(';');
    return {
      kind: 'declare',
      mutable: start.text === 'var',
      name: name.text,
      ...(type ? { type } : {}),
      ...(value ? { value } : {}),
      span: this.span(start, end)
    };
  }

  private parseIf(): FluxStatementNode {
    const start = this.expect('if');
    this.expect('(');
    const condition = parseExpression(this);
    this.expect(')');
    const then = this.parseBlock();
    let otherwise: readonly FluxStatementNode[] | undefined;
    if (this.match('else')) otherwise = this.at('if') ? [this.parseIf()] : this.parseBlock();
    return {
      kind: 'if',
      condition,
      then,
      ...(otherwise ? { otherwise } : {}),
      span: this.span(start, this.previous())
    };
  }

  private parseSwitch(): FluxStatementNode {
    const start = this.expect('switch');
    this.expect('(');
    const selector = parseExpression(this);
    this.expect(')');
    this.expect('{');
    const cases: FluxSwitchCaseNode[] = [];
    while (!this.at('}')) {
      if (this.at('eof')) this.unexpectedEof('Unterminated switch statement.');
      const caseStart = this.current();
      const isDefault = this.match('default');
      const selectors: FluxExpressionNode[] = [];
      if (!isDefault) {
        this.expect('case');
        do selectors.push(parseExpression(this));
        while (this.match(','));
      }
      this.expect(':');
      const body = this.at('{') ? this.parseBlock() : this.parseCaseBody();
      cases.push({
        selectors,
        default: isDefault,
        body,
        span: this.span(caseStart, this.previous())
      });
    }
    const end = this.expect('}');
    return {
      kind: 'switch',
      selector,
      cases,
      span: this.span(start, end)
    };
  }

  private parseCaseBody(): readonly FluxStatementNode[] {
    const body: FluxStatementNode[] = [];
    while (!this.at('case') && !this.at('default') && !this.at('}'))
      body.push(this.parseStatement());
    return body;
  }

  private parseLoop(): FluxStatementNode {
    const start = this.expect('loop');
    this.expect('{');
    const body: FluxStatementNode[] = [];
    let continuing: readonly FluxStatementNode[] = NO_CONTINUING_STATEMENTS;
    while (!this.at('}')) {
      if (this.at('eof')) this.unexpectedEof('Unterminated loop statement.');
      if (this.match('continuing')) {
        continuing = this.parseBlock();
        break;
      }
      body.push(this.parseStatement());
    }
    const end = this.expect('}');
    return {
      kind: 'loop',
      body,
      continuing,
      span: this.span(start, end)
    };
  }

  private parseWhile(): FluxStatementNode {
    const start = this.expect('while');
    this.expect('(');
    const condition = parseExpression(this);
    this.expect(')');
    const body = this.parseBlock();
    return {
      kind: 'while',
      condition,
      body,
      span: this.span(start, this.previous())
    };
  }

  private parseReturn(): FluxStatementNode {
    const start = this.expect('return');
    const value = this.at(';') ? undefined : parseExpression(this);
    const end = this.expect(';');
    return {
      kind: 'return',
      ...(value ? { value } : {}),
      span: this.span(start, end)
    };
  }

  current(): FluxToken {
    return this.tokens[this.index]!;
  }
  previous(): FluxToken {
    return this.tokens[Math.max(0, this.index - 1)]!;
  }
  private peek(offset: number): FluxToken {
    return this.tokens[Math.min(this.tokens.length - 1, this.index + offset)]!;
  }
  at(text: string): boolean {
    return text === 'eof' ? this.current().kind === 'eof' : this.current().text === text;
  }
  consume(): FluxToken {
    return this.tokens[this.index++]!;
  }
  match(text: string): boolean {
    if (!this.at(text)) return false;
    this.index++;
    return true;
  }
  expect(text: string): FluxToken {
    if (!this.at(text)) this.unexpected(`Expected "${text}", received "${this.current().text}".`);
    return this.consume();
  }
  expectIdentifier(): FluxToken {
    return this.expectKind('identifier');
  }
  private expectKind(kind: FluxToken['kind']): FluxToken {
    if (this.current().kind !== kind)
      this.unexpected(`Expected ${kind}, received "${this.current().text}".`);
    return this.consume();
  }
  unsupported(message: string, token = this.current()): never {
    throw new FluxParseFailure(diagnostic('FLUX_UNSUPPORTED_SYNTAX', message, token.span));
  }
  private unexpected(message: string, token = this.current()): never {
    if (token.kind === 'eof') this.unexpectedEof(message);
    throw new FluxParseFailure(diagnostic('FLUX_UNSUPPORTED_SYNTAX', message, token.span));
  }
  private unexpectedEof(message: string): never {
    throw new FluxParseFailure(diagnostic('FLUX_UNEXPECTED_EOF', message, this.current().span));
  }
  span(start: FluxToken, end: FluxToken): SourceSpan {
    return spanAt(
      this.module.uri,
      this.module.content,
      start.start,
      Math.max(1, end.end - start.start)
    );
  }
  spanFrom(start: SourceSpan, end: FluxToken): SourceSpan {
    return Object.freeze({
      ...start,
      length: Math.max(start.length, end.end - this.offsetOf(start))
    });
  }
  private offsetOf(span: SourceSpan): number {
    const lines = this.module.content.split('\n');
    let offset = 0;
    for (let line = 1; line < span.line; line++) offset += lines[line - 1]!.length + 1;
    return offset + span.column - 1;
  }
}

function firstSpan(closure: ResolvedShaderSource): SourceSpan {
  const module =
    closure.modules.find((value) => value.uri === closure.root.uri) ?? closure.modules[0];
  return Object.freeze({ uri: module?.uri ?? closure.root.uri, line: 1, column: 1, length: 1 });
}
function diagnostic(code: string, message: string, primary: SourceSpan): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'parse',
    primary,
    related: NO_RELATED_SPANS
  });
}
