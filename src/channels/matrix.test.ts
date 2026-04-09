import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mockSendHtmlMessage = vi.fn().mockResolvedValue({});
const mockSendTyping = vi.fn().mockResolvedValue({});
const mockStartClient = vi.fn().mockResolvedValue(undefined);
const mockStopClient = vi.fn();
const mockOn = vi.fn();
const mockMxcUrlToHttp = vi.fn((url: string): string | null =>
  url.replace('mxc://', 'https://'),
);

const mockGetRooms = vi.fn(() => [] as object[]);
const mockJoinRoom = vi.fn().mockResolvedValue({});

const mockClient = {
  on: mockOn,
  startClient: mockStartClient,
  stopClient: mockStopClient,
  sendHtmlMessage: mockSendHtmlMessage,
  sendTyping: mockSendTyping,
  getRooms: mockGetRooms,
  joinRoom: mockJoinRoom,
  mxcUrlToHttp: mockMxcUrlToHttp,
};

vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => mockClient),
  ClientEvent: { Sync: 'sync' },
  RoomEvent: { Timeline: 'Room.timeline' },
  RoomMemberEvent: { Membership: 'RoomMember.membership' },
  MsgType: { Text: 'm.text', Audio: 'm.audio' },
}));

vi.mock('../transcription.js', () => ({
  transcribeBuffer: vi.fn().mockResolvedValue('hello world'),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(),
}));

import { readEnvFile } from '../env.js';
import { transcribeBuffer } from '../transcription.js';
import { getChannelFactory } from './registry.js';
import './matrix.js';
import { markdownToHtml } from './matrix.js';

const VALID_ENV = {
  MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
  MATRIX_USER_ID: '@bot:example.com',
  MATRIX_ACCESS_TOKEN: 'syt_test_token',
};

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function makeChannel() {
  (readEnvFile as Mock).mockReturnValue(VALID_ENV);
  const opts = makeOpts();
  return { channel: getChannelFactory('matrix')!(opts)!, opts };
}

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('factory', () => {
    it('returns null when all credentials are missing', () => {
      (readEnvFile as Mock).mockReturnValue({});
      expect(getChannelFactory('matrix')!(makeOpts())).toBeNull();
    });

    it('returns null when only some credentials are present', () => {
      (readEnvFile as Mock).mockReturnValue({
        MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
      });
      expect(getChannelFactory('matrix')!(makeOpts())).toBeNull();
    });

    it('returns a channel when all credentials are present', () => {
      const { channel } = makeChannel();
      expect(channel).not.toBeNull();
      expect(channel.name).toBe('matrix');
    });
  });

  describe('ownsJid', () => {
    it('owns mx: JIDs', () => {
      const { channel } = makeChannel();
      expect(channel.ownsJid('mx:!roomId:server.com')).toBe(true);
    });

    it('does not own other channel JIDs', () => {
      const { channel } = makeChannel();
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('dc:12345')).toBe(false);
      expect(channel.ownsJid('wa:12345@c.us')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      const { channel } = makeChannel();
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after PREPARED sync state', async () => {
      const { channel } = makeChannel();
      await channel.connect();
      const syncCall = mockOn.mock.calls.find(([e]) => e === 'sync')!;
      syncCall[1]('PREPARED', null);
      expect(channel.isConnected()).toBe(true);
    });

    it('returns false after ERROR sync state', async () => {
      const { channel } = makeChannel();
      await channel.connect();
      const syncCall = mockOn.mock.calls.find(([e]) => e === 'sync')!;
      syncCall[1]('PREPARED', null);
      syncCall[1]('ERROR', 'PREPARED');
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('registers sync and timeline listeners then starts the client', async () => {
      const { channel } = makeChannel();
      await channel.connect();
      const registeredEvents = mockOn.mock.calls.map(([e]) => e);
      expect(registeredEvents).toContain('sync');
      expect(registeredEvents).toContain('Room.timeline');
      expect(mockStartClient).toHaveBeenCalledWith({ initialSyncLimit: 0 });
    });
  });

  describe('sendMessage', () => {
    it('sends an HTML message to the Matrix room', async () => {
      const { channel } = makeChannel();
      await channel.sendMessage('mx:!roomId:server.com', 'Hello, Matrix!');
      expect(mockSendHtmlMessage).toHaveBeenCalledWith(
        '!roomId:server.com',
        'Hello, Matrix!',
        'Hello, Matrix!',
      );
    });

    it('converts markdown to HTML in the formatted body', async () => {
      const { channel } = makeChannel();
      await channel.sendMessage('mx:!roomId:server.com', '*bold* and _italic_');
      expect(mockSendHtmlMessage).toHaveBeenCalledWith(
        '!roomId:server.com',
        '*bold* and _italic_',
        '<strong>bold</strong> and <em>italic</em>',
      );
    });

    it('splits messages longer than 32000 chars', async () => {
      const { channel } = makeChannel();
      const long = 'A'.repeat(32001);
      await channel.sendMessage('mx:!roomId:server.com', long);
      expect(mockSendHtmlMessage).toHaveBeenCalledTimes(2);
    });

    it('sends multi-part messages in order', async () => {
      const { channel } = makeChannel();
      const part1 = 'A'.repeat(32000);
      const part2 = 'B';
      await channel.sendMessage('mx:!roomId:server.com', part1 + part2);
      expect(mockSendHtmlMessage.mock.calls[0][1]).toBe(part1);
      expect(mockSendHtmlMessage.mock.calls[1][1]).toBe(part2);
    });
  });

  describe('markdownToHtml', () => {
    it('converts bold', () => {
      expect(markdownToHtml('**bold**')).toBe('<strong>bold</strong>');
    });

    it('converts single-asterisk to bold (WhatsApp convention)', () => {
      expect(markdownToHtml('*bold*')).toBe('<strong>bold</strong>');
    });

    it('converts italic with underscores', () => {
      expect(markdownToHtml('_italic_')).toBe('<em>italic</em>');
    });

    it('converts inline code', () => {
      expect(markdownToHtml('`code`')).toBe('<code>code</code>');
    });

    it('protects code blocks from markdown processing', () => {
      expect(markdownToHtml('```\n**not bold**\n```')).toBe(
        '<pre><code>**not bold**</code></pre>',
      );
    });

    it('converts headings', () => {
      expect(markdownToHtml('# Title')).toBe('<h1>Title</h1>');
      expect(markdownToHtml('## Section')).toBe('<h2>Section</h2>');
    });

    it('converts links', () => {
      expect(markdownToHtml('[text](https://example.com)')).toBe(
        '<a href="https://example.com">text</a>',
      );
    });

    it('escapes HTML special chars outside code', () => {
      expect(markdownToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });

    it('escapes HTML inside code blocks', () => {
      expect(markdownToHtml('`<script>`')).toBe('<code>&lt;script&gt;</code>');
    });
  });

  describe('setTyping', () => {
    it('sends typing=true with 30s timeout', async () => {
      const { channel } = makeChannel();
      await channel.setTyping!('mx:!roomId:server.com', true);
      expect(mockSendTyping).toHaveBeenCalledWith(
        '!roomId:server.com',
        true,
        30000,
      );
    });

    it('sends typing=false with 0 timeout', async () => {
      const { channel } = makeChannel();
      await channel.setTyping!('mx:!roomId:server.com', false);
      expect(mockSendTyping).toHaveBeenCalledWith(
        '!roomId:server.com',
        false,
        0,
      );
    });
  });

  describe('disconnect', () => {
    it('stops the matrix client and marks disconnected', async () => {
      const { channel } = makeChannel();
      await channel.connect();
      const syncCall = mockOn.mock.calls.find(([e]) => e === 'sync')!;
      syncCall[1]('PREPARED', null);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(mockStopClient).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('timeline event handling', () => {
    function getTimelineCallback() {
      const call = mockOn.mock.calls.find(([e]) => e === 'Room.timeline')!;
      return call[1] as (
        event: object,
        room: object | undefined,
        toStartOfTimeline: boolean,
      ) => void;
    }

    const mockRoom = {
      getMember: (userId: string) => ({
        name: userId === '@user:server.com' ? 'Alice' : userId,
      }),
      name: 'Test Room',
    };

    function makeEvent(
      overrides: Partial<{
        type: string;
        msgtype: string;
        body: string;
        url: string;
        sender: string;
        roomId: string;
        id: string;
      }> = {},
    ) {
      const opts = {
        type: 'm.room.message',
        msgtype: 'm.text',
        body: 'Hello!',
        url: undefined as string | undefined,
        sender: '@user:server.com',
        roomId: '!roomId:server.com',
        id: 'event_1',
        ...overrides,
      };
      return {
        getType: () => opts.type,
        getContent: () => ({
          msgtype: opts.msgtype,
          body: opts.body,
          url: opts.url,
        }),
        getSender: () => opts.sender,
        getRoomId: () => opts.roomId,
        getId: () => opts.id,
        getTs: () => 1234567890000,
      };
    }

    it('delivers a valid text message to onMessage', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      const cb = getTimelineCallback();

      cb(makeEvent(), mockRoom, false);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!roomId:server.com',
        '2009-02-13T23:31:30.000Z',
        'Test Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!roomId:server.com',
        expect.objectContaining({
          id: 'event_1',
          chat_jid: 'mx:!roomId:server.com',
          sender: '@user:server.com',
          sender_name: 'Alice',
          content: 'Hello!',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('ignores messages from the bot itself', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      getTimelineCallback()(
        makeEvent({ sender: '@bot:example.com' }),
        mockRoom,
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores historical events (toStartOfTimeline = true)', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      getTimelineCallback()(makeEvent(), mockRoom, true);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-message events', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      getTimelineCallback()(
        makeEvent({ type: 'm.room.member' }),
        mockRoom,
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-text message types', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      getTimelineCallback()(makeEvent({ msgtype: 'm.image' }), mockRoom, false);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('falls back to sender ID when room member name is unavailable', async () => {
      const { channel, opts } = makeChannel();
      await channel.connect();
      const roomWithNoMember = {
        getMember: () => null,
        name: 'Unnamed Room',
      };
      getTimelineCallback()(makeEvent(), roomWithNoMember, false);
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sender_name: '@user:server.com' }),
      );
    });

    describe('audio messages', () => {
      const mockFetch = vi.fn();

      beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
      });

      it('transcribes audio and delivers [Voice: ...] content', async () => {
        const { channel, opts } = makeChannel();
        await channel.connect();
        const cb = getTimelineCallback();

        cb(
          makeEvent({ msgtype: 'm.audio', url: 'mxc://server.com/abc123' }),
          mockRoom,
          false,
        );

        await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
        expect(opts.onMessage).toHaveBeenCalledWith(
          'mx:!roomId:server.com',
          expect.objectContaining({ content: '[Voice: hello world]' }),
        );
      });

      it('delivers fallback when mxcUrlToHttp returns null', async () => {
        mockMxcUrlToHttp.mockReturnValueOnce(null);
        const { channel, opts } = makeChannel();
        await channel.connect();
        const cb = getTimelineCallback();

        cb(
          makeEvent({ msgtype: 'm.audio', url: 'mxc://server.com/abc123' }),
          mockRoom,
          false,
        );

        await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
        expect(opts.onMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            content: '[Voice Message - transcription unavailable]',
          }),
        );
      });

      it('delivers fallback when fetch throws', async () => {
        mockFetch.mockRejectedValueOnce(new Error('network error'));
        const { channel, opts } = makeChannel();
        await channel.connect();
        const cb = getTimelineCallback();

        cb(
          makeEvent({ msgtype: 'm.audio', url: 'mxc://server.com/abc123' }),
          mockRoom,
          false,
        );

        await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
        expect(opts.onMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            content: '[Voice Message - transcription failed]',
          }),
        );
      });

      it('passes the downloaded buffer to transcribeBuffer', async () => {
        const { channel } = makeChannel();
        await channel.connect();
        const cb = getTimelineCallback();

        cb(
          makeEvent({ msgtype: 'm.audio', url: 'mxc://server.com/abc123' }),
          mockRoom,
          false,
        );

        await vi.waitFor(() =>
          expect(transcribeBuffer as Mock).toHaveBeenCalled(),
        );
        expect(transcribeBuffer as Mock).toHaveBeenCalledWith(
          expect.any(Buffer),
          undefined,
        );
      });
    });
  });
});
