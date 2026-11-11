/**
 * Base class for errors we expect and can explain to the user.
 * `hint` tells the user what to do next. The UI prints it under the message.
 * Anything that is NOT a HephError is a bug and is shown with less polish.
 */
export class HephError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.hint = hint;
  }
}
