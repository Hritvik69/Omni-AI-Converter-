import { HttpError } from "./middleware/errors.js";

export function requiredParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(422, `Missing route parameter: ${name}`);
  }
  return value;
}
