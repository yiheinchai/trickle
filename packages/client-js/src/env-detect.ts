/**
 * Detect the runtime environment from environment variables.
 * Returns a human-readable string identifying where this code is running.
 */
export function detectEnvironment(): string {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};

  if (env.AWS_LAMBDA_FUNCTION_NAME) return 'lambda';
  if (env.VERCEL) return 'vercel';
  if (env.RAILWAY_ENVIRONMENT) return 'railway';
  if (env.K_SERVICE) return 'cloud-run';
  if (env.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions';
  if (env.GOOGLE_CLOUD_PROJECT) return 'gcp';
  if (env.ECS_CONTAINER_METADATA_URI) return 'ecs';
  if (env.FLY_APP_NAME) return 'fly';
  if (env.RENDER_SERVICE_ID) return 'render';
  if (env.HEROKU_APP_NAME || env.DYNO) return 'heroku';
  if (env.CODESPACE_NAME) return 'codespace';
  if (env.GITPOD_WORKSPACE_ID) return 'gitpod';

  return 'node';
}
