// Smoke test: open a ticketed socket against the running server, sync, send an update, call ping RPC.
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { readFileSync } from 'node:fs';

const t = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const docId = readFileSync(process.argv[3], 'utf8').trim();
const url = `${t.wsUrl}/v1/docs/${docId}?ticket=${t.ticket}`;
const ydoc = new Y.Doc();
const ws = new WebSocket(url, { origin: 'http://localhost:3000' });
ws.binaryType = 'arraybuffer';
let synced = false;
const done = (msg, code = 0) => { console.log(msg); ws.close(); setTimeout(() => process.exit(code), 100); };
setTimeout(() => done('TIMEOUT', 1), 8000);

ws.on('open', () => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, ydoc);
  ws.send(encoding.toUint8Array(enc));
});
ws.on('message', (data) => {
  const dec = decoding.createDecoder(new Uint8Array(data));
  const type = decoding.readVarUint(dec);
  if (type === 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const st = syncProtocol.readSyncMessage(dec, enc, ydoc, 'remote');
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (st === 1 && !synced) {
      synced = true;
      const frag = ydoc.getXmlFragment('content');
      console.log('synced; blocks =', frag.length, '; text =', JSON.stringify(frag.toString().replace(/<[^>]+>/g, '').slice(0, 60)));
      // ping RPC
      const e2 = encoding.createEncoder();
      encoding.writeVarUint(e2, 10);
      encoding.writeVarString(e2, JSON.stringify({ id: '1', method: 'ping', params: { t: Date.now() } }));
      ws.send(encoding.toUint8Array(e2));
    }
  } else if (type === 11) {
    console.log('rpc result:', decoding.readVarString(dec));
    done('OK');
  } else if (type === 12) {
    console.log('event:', decoding.readVarString(dec).slice(0, 120));
  }
});
ws.on('unexpected-response', (_req, res) => done(`UPGRADE REJECTED ${res.statusCode}`, 1));
ws.on('error', (e) => done(`ERROR ${e.message}`, 1));
