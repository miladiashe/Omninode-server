import { describe, expect, it } from 'vitest';
import { _getAwsSignatureDetails } from '../src/llm/sigv4.js';

describe('AWS Signature Version 4', () => {
  it('AWS get-vanilla 벡터의 canonical request·hash·signature가 일치한다', () => {
    const details = _getAwsSignatureDetails({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      headers: {
        host: 'example.amazonaws.com',
        'x-amz-date': '20150830T123600Z',
      },
      body: '',
      now: new Date('2015-08-30T12:36:00Z'),
      includeContentSha256: false,
    });

    const expectedCanonicalRequest = [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'host;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n');

    expect(details.canonicalRequest).toBe(expectedCanonicalRequest);
    expect(details.stringToSign.split('\n').at(-1))
      .toBe('bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
    expect(details.signature)
      .toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});
