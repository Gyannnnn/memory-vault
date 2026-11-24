import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, apiUrl } from './session';

/** Server components call the API directly with the session's access token. */
export async function serverApi<T>(path: string): Promise<T> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/sign-in');
  const response = await fetch(`${apiUrl()}/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.status === 401) redirect('/sign-in');
  if (!response.ok) throw new Error(`The API answered ${response.status} for ${path}`);
  return (await response.json()) as T;
}
