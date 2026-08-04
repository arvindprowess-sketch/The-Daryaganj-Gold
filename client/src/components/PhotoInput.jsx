import { useRef, useState } from 'react';
import { isMobile } from '../lib/device.js';
import { compressImage } from '../lib/image.js';
import { api } from '../lib/api.js';

// Device-aware photo control.
//   Desktop: a single "Upload" button (file picker). NO camera.
//   Mobile : two buttons — [Take Photo] (capture) and [Upload].
// Compresses to max 1200px before upload. Returns the stored URL via onUploaded.
export default function PhotoInput({ value, onUploaded, uploadOnly = false, itemName }) {
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const showCamera = isMobile && !uploadOnly;

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking same file
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const compressed = await compressImage(file);
      const fd = new FormData();
      fd.append('photo', compressed);
      // Sent so the stored object is named after the item, not a random blob.
      if (itemName) fd.append('item_name', itemName);
      const { url } = await api.upload('/upload', fd);
      onUploaded(url);
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        {showCamera && (
          <>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment"
                   className="hidden" onChange={handleFile} />
            <button type="button" className="btn-ghost flex-1"
                    onClick={() => cameraRef.current?.click()} disabled={busy}>
              📷 Take Photo
            </button>
          </>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/jpg,image/webp"
               className="hidden" onChange={handleFile} />
        <button type="button" className="btn-ghost flex-1"
                onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : '⬆️ Upload'}
        </button>
      </div>
      {value && (
        <div className="mt-2 flex items-center gap-2">
          <img src={value} alt="entry" className="h-16 w-16 rounded-lg object-cover border" />
          <button type="button" className="text-sm text-red-600 underline"
                  onClick={() => onUploaded(null)}>remove photo</button>
        </div>
      )}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
