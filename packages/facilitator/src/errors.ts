export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const bad = (code: string, msg: string) => new HttpError(400, code, msg);
