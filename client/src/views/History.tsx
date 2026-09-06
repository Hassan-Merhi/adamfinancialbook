import type { ComponentProps } from 'react';
import { useLiveRevision } from '../live-subscription';
import HistoryBase from './HistoryBase';

type Props = ComponentProps<typeof HistoryBase>;

export default function History(props: Props) {
  const revision = useLiveRevision(['history']);
  return <HistoryBase key={revision} {...props} />;
}
