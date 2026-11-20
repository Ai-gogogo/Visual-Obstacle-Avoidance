export function wavRecording(chunks, sampleRate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength,0);
  const header = new DataView(new ArrayBuffer(44));
  header.setUint32(0,0x52494646);
  header.setUint32(4,36+length,true);
  header.setUint32(8,0x57415645);
  header.setUint32(12,0x666d7420);
  header.setUint32(16,16,true);
  header.setUint16(20,1,true);
  header.setUint16(22,1,true);
  header.setUint32(24,sampleRate,true);
  header.setUint32(28,sampleRate*2,true);
  header.setUint16(32,2,true);
  header.setUint16(34,16,true);
  header.setUint32(36,0x64617461);
  header.setUint32(40,length,true);
  return new Blob([header,...chunks],{type:'audio/wav'});
}
