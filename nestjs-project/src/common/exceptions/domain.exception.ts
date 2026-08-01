export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotVisibleException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_VISIBLE',
      403,
      'This video is not visible to the current requester',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for streaming/download');
  }
}

export class UploadMetadataInvalidException extends DomainException {
  constructor(message = 'Upload metadata is missing or invalid') {
    super('UPLOAD_METADATA_INVALID', 400, message);
  }
}

export class UploadForbiddenException extends DomainException {
  constructor() {
    super(
      'UPLOAD_FORBIDDEN',
      403,
      'The authenticated user does not own this upload',
    );
  }
}
