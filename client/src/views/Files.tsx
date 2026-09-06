import type { ComponentProps } from 'react';
import { useLiveRevision } from '../live-subscription';
import FilesBase from './FilesBase';

type Props = ComponentProps<typeof FilesBase>;

export default function Files(props: Props) {
  const revision = useLiveRevision(['files', 'access']);
  return <FilesBase key={revision} {...props} />;
}
