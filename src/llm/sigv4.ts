import { createHash, createHmac } from 'node:crypto';

export interface SignAwsRequestInput {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  headers: Record<string, string>;
  body: string;
  now?: Date;
  /** AWS's get-vanilla test vector omits this otherwise-required Bedrock header. */
  includeContentSha256?: boolean;
}

export interface AwsSignatureDetails {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signedHeaders: string;
  signature: string;
}

function _sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function _hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function _rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function _canonicalUri(url: string): string {
  const pathname = new URL(url).pathname || '/';
  return pathname.split('/').map(_rfc3986Encode).join('/');
}

function _amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function _getAwsSignatureDetails(input: SignAwsRequestInput): AwsSignatureDetails {
  const url = new URL(input.url);
  const amzDate = _amzDate(input.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = _sha256Hex(input.body);

  const normalizedHeaders = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers)) {
    normalizedHeaders.set(name.toLowerCase(), value.trim());
  }
  normalizedHeaders.set('host', url.host);
  normalizedHeaders.set('x-amz-date', amzDate);
  if (input.includeContentSha256 !== false) {
    normalizedHeaders.set('x-amz-content-sha256', payloadHash);
  }
  if (input.sessionToken) {
    normalizedHeaders.set('x-amz-security-token', input.sessionToken.trim());
  }

  const headerNames = [...normalizedHeaders.keys()].sort();
  const canonicalHeaders = headerNames
    .map(name => `${name}:${normalizedHeaders.get(name)!}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    _canonicalUri(input.url),
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    _sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = _hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = _hmac(kDate, input.region);
  const kService = _hmac(kRegion, input.service);
  const kSigning = _hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = Object.fromEntries(
    headerNames.map(name => [name, normalizedHeaders.get(name)!]),
  ) as Record<string, string>;
  headers.Authorization = authorization;

  return { headers, canonicalRequest, stringToSign, signedHeaders, signature };
}

export function signAwsRequest(input: SignAwsRequestInput): Record<string, string> {
  return _getAwsSignatureDetails(input).headers;
}
