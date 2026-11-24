const devices: Record<string, string> = {
  laptop: 'Laptop',
  phone: 'Phone',
  web: 'Web uploads',
  mobile: 'Mobile uploads',
  's3-direct': 'Direct to S3',
};

/** "phone:s21fe" → "Phone · s21fe" (the same names as the mirrored folder trees). */
export function sourceLabel(sourceId: string): string {
  const [device = sourceId, ...rest] = sourceId.split(':');
  const name = devices[device] ?? device.charAt(0).toUpperCase() + device.slice(1);
  return rest.length ? `${name} · ${rest.join(':')}` : name;
}
