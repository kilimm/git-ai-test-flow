// 本文件所有改动要求遵循 agent-rules 规范
import { useState } from 'react';
import { Alert, Button, Modal, Spin } from 'antd';
import { Download, FileText, Image as ImageIcon } from 'lucide-react';
import { api } from '../api/client';

export interface ArtifactLike {
  id?: string;
  type?: string;
  mime?: string;
}

export default function ArtifactPreview({
  runId,
  artifact,
}: {
  runId: string;
  artifact: ArtifactLike;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (artifact.id === undefined) {
    return null;
  }

  const url = api.artifactUrl(runId, artifact.id);
  const isScreenshot = artifact.type === 'screenshot' || artifact.mime?.startsWith('image/');
  const isTrace = artifact.type === 'trace' || artifact.mime?.includes('zip');

  if (isScreenshot) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-gh-blue"
      >
        <ImageIcon size={13} /> 截图
      </a>
    );
  }

  if (isTrace) {
    return (
      <a href={url} download className="inline-flex items-center gap-1 text-xs text-gh-blue">
        <Download size={13} /> Trace
      </a>
    );
  }

  const showText = async (): Promise<void> => {
    setOpen(true);
    setLoading(true);
    setError(null);

    try {
      setText(await api.artifactText(runId, artifact.id as string));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取产物');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void showText();
        }}
        className="inline-flex items-center gap-1 text-xs text-gh-blue"
      >
        <FileText size={13} /> {artifact.type ?? '产物'}
      </button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <Button icon={<Download size={14} />} href={url} download>
            下载
          </Button>
        }
        title="产物内容"
        width={860}
      >
        {loading && <Spin />}
        {error !== null && <Alert type="error" showIcon message={error} />}
        {text !== null && (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded bg-gh-canvas p-3 font-mono text-xs">
            {text}
          </pre>
        )}
      </Modal>
    </>
  );
}
