// Decimal arithmetic without binary floating-point drift. Six decimal places,
// rounded half away from zero; callers must supply independently verified inputs.
export function calculate(operator: string, left: string, right: string) {
  const scale = 1_000_000n;
  const parse = (value: string) => {
    if (!/^-?\d{1,9}(?:\.\d{1,6})?$/.test(value))
      throw new Error("invalid_operand");
    const sign = value.startsWith("-") ? -1n : 1n;
    const [whole, fraction = ""] = value.replace("-", "").split(".");
    return sign * (BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0")));
  };
  const divide = (numerator: bigint, denominator: bigint) => {
    if (!denominator) throw new Error("division_by_zero");
    const negative = numerator < 0n !== denominator < 0n;
    const n = numerator < 0n ? -numerator : numerator;
    const d = denominator < 0n ? -denominator : denominator;
    return (negative ? -1n : 1n) * ((n + d / 2n) / d);
  };
  const a = parse(left),
    b = parse(right);
  let result: bigint;
  if (operator === "add") result = a + b;
  else if (operator === "subtract") result = a - b;
  else if (operator === "multiply") result = divide(a * b, scale);
  else if (operator === "divide") result = divide(a * scale, b);
  else throw new Error("invalid_operator");
  const sign = result < 0n ? "-" : "";
  const n = result < 0n ? -result : result;
  const fraction = (n % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${n / scale}${fraction ? "." + fraction : ""}`;
}
