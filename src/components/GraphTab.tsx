import { useStore } from '../store';
import { TableSidebar } from './TableSidebar';
import { LineageGraphView } from './LineageGraphView';
import { ColumnDetail } from './ColumnDetail';
import { FileImporter } from './FileImporter';

export function GraphTab() {
  const graph = useStore((s) => s.graph);
  const files = useStore((s) => s.files);

  if (!graph || !files.length) {
    return (
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 640 }}>
          <FileImporter />
        </div>
      </div>
    );
  }

  return (
    <div className="layout-split">
      <TableSidebar />
      <div className="graph-area">
        <LineageGraphView graph={graph} />
        <ColumnDetail />
      </div>
    </div>
  );
}
