// The value, or an error naming what was missing. For rows the surrounding
// code has already established exist, such as the parent of one just read.
export const required = <V>(value: V | null | undefined, what: string): V => {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${what}`);
  }
  return value;
};
