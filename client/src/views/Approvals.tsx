import type { ComponentProps } from 'react';
import { useLiveRevision } from '../live-subscription';
import ApprovalsBase from './ApprovalsBase';

type Props = ComponentProps<typeof ApprovalsBase>;

export default function Approvals(props: Props) {
  const revision = useLiveRevision(['approvals'], (detail) =>
    detail.method === 'REMOTE' || !detail.path.startsWith('/api/delegation/'));
  return <ApprovalsBase key={revision} {...props} />;
}
