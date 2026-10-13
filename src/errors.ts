/** A problem the user can fix, shown to them as is (HTTP 4xx). */
export class UserError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 413 | 422 | 429 = 400,
  ) {
    super(message);
  }
}
