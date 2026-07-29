// A typed error hierarchy so controllers can throw something specific
// ("this team doesn't exist") and one central handler decides how that maps
// to an HTTP response, instead of every controller deciding status codes
// and response shape for itself.
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super(`${resource} ${id} not found`, 404);
  }
}
