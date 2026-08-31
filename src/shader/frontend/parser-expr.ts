import type { FluxExpressionNode, FluxTypeNode, SourceSpan } from '../types';
import type { FluxToken } from './lexer';

export const BINARY_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10
});

export interface IExpressionParserHost {
  readonly tokens: readonly FluxToken[];
  index: number;
  current(): FluxToken;
  previous(): FluxToken;
  at(text: string): boolean;
  consume(): FluxToken;
  match(text: string): boolean;
  expect(text: string): FluxToken;
  expectIdentifier(): FluxToken;
  unsupported(message: string, token?: FluxToken): never;
  span(start: FluxToken, end: FluxToken): SourceSpan;
  spanFrom(start: SourceSpan, end: FluxToken): SourceSpan;
  parseType(): FluxTypeNode;
}

const NO_TYPE_ARGUMENTS: readonly FluxTypeNode[] = Object.freeze([]);

export function parseExpression(
  host: IExpressionParserHost,
  minimumPrecedence = 0
): FluxExpressionNode {
  let left = parseUnary(host);
  while (true) {
    const precedence = BINARY_PRECEDENCE[host.current().text];
    if (precedence === undefined || precedence < minimumPrecedence) break;
    const operator = host.consume();
    const right = parseExpression(host, precedence + 1);
    left = {
      kind: 'binary',
      operator: operator.text,
      left,
      right,
      span: host.spanFrom(left.span, host.previous())
    };
  }
  return left;
}

export function parseUnary(host: IExpressionParserHost): FluxExpressionNode {
  if (host.at('!') || host.at('-') || host.at('+') || host.at('~')) {
    const operator = host.consume();
    const operand = parseUnary(host);
    return {
      kind: 'unary',
      operator: operator.text,
      operand,
      span: host.span(operator, host.previous())
    };
  }
  return parsePostfix(host);
}

export function parsePostfix(host: IExpressionParserHost): FluxExpressionNode {
  let expression = parsePrimary(host);
  while (true) {
    if (host.match('.')) {
      const field = host.expectIdentifier();
      expression = {
        kind: 'field',
        base: expression,
        field: field.text,
        span: host.spanFrom(expression.span, field)
      };
    } else if (host.match('[')) {
      const index = parseExpression(host);
      const end = host.expect(']');
      expression = {
        kind: 'index',
        base: expression,
        index,
        span: host.spanFrom(expression.span, end)
      };
    } else break;
  }
  return expression;
}

export function parsePrimary(host: IExpressionParserHost): FluxExpressionNode {
  const token = host.current();
  if (token.kind === 'number') {
    host.consume();
    const suffix = token.text.at(-1);
    const literalType =
      suffix === 'u'
        ? 'u32'
        : suffix === 'i'
          ? 'i32'
          : token.text.includes('.') || suffix === 'f'
            ? 'f32'
            : 'i32';
    const normalized = token.text.replace(/[fiu]$/, '');
    return {
      kind: 'literal',
      value: Number(normalized),
      literalType,
      span: token.span
    };
  }
  if (token.text === 'true' || token.text === 'false') {
    host.consume();
    return {
      kind: 'literal',
      value: token.text === 'true',
      literalType: 'bool',
      span: token.span
    };
  }
  if (host.match('(')) {
    const expression = parseExpression(host);
    host.expect(')');
    return expression;
  }
  if (token.kind !== 'identifier')
    host.unsupported(`Expected expression, received "${token.text}".`, token);
  const start = host.consume();
  const checkpoint = host.index;
  let typeArguments: readonly FluxTypeNode[] = NO_TYPE_ARGUMENTS;
  if (host.at('<')) {
    try {
      host.consume();
      const arguments_: FluxTypeNode[] = [];
      do arguments_.push(host.parseType());
      while (host.match(','));
      host.expect('>');
      if (!host.at('(')) host.index = checkpoint;
      else typeArguments = arguments_;
    } catch {
      host.index = checkpoint;
    }
  }
  if (host.match('(')) {
    const arguments_: FluxExpressionNode[] = [];
    while (!host.at(')')) {
      arguments_.push(parseExpression(host));
      if (!host.match(',')) break;
    }
    const end = host.expect(')');
    return {
      kind: 'call',
      callee: start.text,
      typeArguments,
      arguments: arguments_,
      span: host.span(start, end)
    };
  }
  return { kind: 'name', name: start.text, span: start.span };
}
