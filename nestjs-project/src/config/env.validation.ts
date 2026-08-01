import * as Joi from 'joi';

export interface EnvVars {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_EXPIRATION: string;
  JWT_REFRESH_EXPIRATION: string;
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: number;
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: number;
  APP_URL: string;
  MAIL_HOST: string;
  MAIL_PORT: number;
  MAIL_FROM: string;
  SWAGGER_ENABLED: 'true' | 'false';
  S3_INTERNAL_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
}

export const envValidationSchema = Joi.object<EnvVars>({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  S3_INTERNAL_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:9000'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().default('streamtube-videos'),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().default(6379),
});
