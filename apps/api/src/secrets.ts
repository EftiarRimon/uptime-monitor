const privileged = new Set(["owner", "admin"]);

/** Heartbeat tokens act as secrets, so only owners and admins may read them. */
export function monitorView<T extends Record<string, unknown>>(
  monitor: T,
  role: string | undefined,
) {
  if (role && privileged.has(role)) return monitor;
  const { heartbeat_token, ...rest } = monitor;
  void heartbeat_token;
  return rest;
}
