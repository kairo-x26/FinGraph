import { connect } from 'node:net';
import type { Config } from '../../config';

export interface ScanResult {
  clean: boolean;
  engine: string;
  engine_version: string;
  threats: string[];
  warnings: string[];
  scanned_at: string;
}

export interface MalwareScanner {
  scan(data: Buffer, mime: string): Promise<ScanResult>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const EXECUTABLE_MAGIC: [string, Buffer][] = [
  ['Win.Executable.PE', Buffer.from('MZ')],
  ['Unix.Executable.ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ['MacOS.Executable.MachO', Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
  ['MacOS.Executable.MachO', Buffer.from([0xfe, 0xed, 0xfa, 0xcf])],
];

/**
 * Built-in content checks: the EICAR test signature, executable payloads, and
 * dangerous PDF actions. Deployments should use ClamAV (or a managed scanner) in
 * addition; this is the baseline that always runs.
 */
export class BuiltinScanner implements MalwareScanner {
  async scan(data: Buffer, mime: string): Promise<ScanResult> {
    const threats: string[] = [];
    const warnings: string[] = [];
    const latin = data.toString('latin1');
    if (latin.includes(EICAR)) threats.push('Eicar-Test-Signature');
    for (const [name, magic] of EXECUTABLE_MAGIC) {
      if (data.subarray(0, magic.length).equals(magic)) threats.push(name);
    }
    if (mime === 'application/pdf') {
      if (/\/Launch\b/.test(latin)) threats.push('Pdf.Action.Launch');
      if (/\/(JavaScript|JS)\b/.test(latin)) warnings.push('pdf_active_content');
      if (/\/EmbeddedFile\b/.test(latin)) warnings.push('pdf_embedded_file');
      if (/\/Encrypt\b/.test(latin)) warnings.push('pdf_encrypted');
    }
    return {
      clean: threats.length === 0,
      engine: 'fingraph-builtin',
      engine_version: '1.0',
      threats: [...new Set(threats)],
      warnings,
      scanned_at: new Date().toISOString(),
    };
  }
}

/** ClamAV clamd INSTREAM client, chained after the built-in checks. */
export class ClamAvScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly builtin = new BuiltinScanner(),
  ) {}

  async scan(data: Buffer, mime: string): Promise<ScanResult> {
    const base = await this.builtin.scan(data, mime);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(this.port, this.host);
      let out = '';
      socket.setTimeout(30_000, () => socket.destroy(new Error('clamd timeout')));
      socket.on('error', reject);
      socket.on('data', (d) => (out += d.toString()));
      socket.on('end', () => resolve(out));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
    const found = reply.match(/stream: (.+) FOUND/);
    const threats = found ? [...base.threats, found[1]!] : base.threats;
    return { ...base, clean: threats.length === 0, threats, engine: 'clamav+fingraph-builtin', engine_version: reply.trim().slice(0, 80) };
  }
}

export function createScanner(config: Config): MalwareScanner {
  return config.MALWARE_SCANNER === 'clamav' ? new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT) : new BuiltinScanner();
}
