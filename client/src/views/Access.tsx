import type { ComponentProps } from 'react';
import { useLiveRevision } from '../live-subscription';
import AccessBase from './AccessBase';

type Props = ComponentProps<typeof AccessBase>;

export default function Access(props: Props) {
  const revision = useLiveRevision(['access'], (detail) => {
    if (detail.method === 'REMOTE') return true;
    if (/^\/api\/users(?:\/|$)/.test(detail.path)) return false;
    if (/^\/api\/delegation\/users\/[^/]+\/accounts$/.test(detail.path)) return false;
    return true;
  });
  return <AccessBase key={revision} {...props} />;
}
