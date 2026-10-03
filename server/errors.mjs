export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertApi(condition, status, code, message, details = null) {
  if (!condition) throw new ApiError(status, code, message, details);
}
