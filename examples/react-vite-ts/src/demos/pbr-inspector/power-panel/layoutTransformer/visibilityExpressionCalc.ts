import { get } from 'lodash-es';
import { type Expression, Operators } from '../types';
import { buildRealPath, type ListParams } from '../utils';

function expressExecute(operator: Operators, value: unknown, targetValue: unknown) {
  if (operator === Operators.Equal) {
    return value === targetValue;
  }
  if (operator === Operators.NotEqual) {
    return value !== targetValue;
  }
  if (operator === Operators.In) {
    return Array.isArray(value) && value.includes(targetValue);
  }
  if (operator === Operators.NotIn) {
    return Array.isArray(value) && !value.includes(targetValue);
  }
  throw new Error(`Invalid operator: ${operator}`);
}

export default function visibilityExpressionCalc(
  exporession: Expression | Expression[],
  object: unknown,
  listParams: ListParams = {
    isInListLoop: false
  }
): boolean {
  if (object === null) {
    return false;
  }
  if (Array.isArray(exporession[0])) {
    return (exporession as Expression[]).every((exp) =>
      visibilityExpressionCalc(exp, object, listParams)
    );
  }

  const [path, operator, value] = exporession as Expression;
  const realPath = buildRealPath(path, listParams);
  let targetValue = get(object, realPath);
  if (!Array.isArray(targetValue)) {
    targetValue = [targetValue];
  }
  return (targetValue as unknown[]).some((singleTargetValue) =>
    expressExecute(operator, value, singleTargetValue)
  );
}
