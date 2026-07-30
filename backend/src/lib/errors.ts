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

// 502, not 500: this means "a service we depend on failed us," not "we have
// a bug." Distinguishing them matters for a third-party API we don't
// control (see docs/CLAUDE.md) -- the status code itself communicates
// whose fault it is, which is useful both for the frontend (retry-worthy?)
// and for us (nothing to fix in our own code when this fires).
export class UpstreamError extends AppError {
  constructor(message: string) {
    super(message, 502);
  }
}
