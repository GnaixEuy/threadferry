export function nativeRuntimeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.THREADFERRY_WECOM_BOT_SECRET;
  delete env.WECOM_CLI_CONFIG_DIR;
  return env;
}
