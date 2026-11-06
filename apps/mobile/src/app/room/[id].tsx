import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Body, Centered, Muted } from '@/components/ui';

export default function Room() {
  const { id } = useLocalSearchParams<{ id: Id<'rooms'> }>();
  const data = useQuery(api.rooms.get, { roomId: id });
  const timeline = useQuery(api.messages.timeline, { roomId: id });
  // KeyboardAvoidingView needs the view's distance from the top of the
  // window to size its padding correctly.
  const [offset, setOffset] = useState(0);
  const containerRef = useRef<React.ComponentRef<typeof View>>(null);
  // A normal (not inverted) list that sticks to the bottom while you're near
  // it. Inverted lists flip the scroll view, which breaks the iOS 26 scroll
  // edge blur under the header.
  const listRef = useRef<FlatList>(null);
  const stickToBottom = useRef(true);

  if (data === undefined || timeline === undefined) return <Centered><ActivityIndicator /></Centered>;
  if (data === null) return <Centered><Body>Room not found.</Body></Centered>;

  const names = new Map(data.participants.map((p) => [p._id, p]));

  return (
    <>
      <Stack.Screen options={{ title: data.room.name, headerLargeTitle: false }} />
      <View
        ref={containerRef}
        style={{ flex: 1 }}
        onLayout={() => containerRef.current?.measureInWindow((_x: number, y: number) => setOffset(y))}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={offset}>
          <FlatList
            ref={listRef}
            data={timeline}
            keyExtractor={(item) => item.id}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            scrollEventThrottle={64}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent;
              const fromBottom = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
              stickToBottom.current = fromBottom < 120;
            }}
            onContentSizeChange={() => {
              if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: false });
            }}
            onLayout={() => {
              if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: false });
            }}
            ListEmptyComponent={
              <Muted style={styles.empty}>Say something to start. Participants read the project at {data.room.cwd}.</Muted>
            }
            renderItem={({ item }) => {
              const author = names.get(item.authorParticipantId);
              const mine = author?.kind === 'human';
              if (item.kind === 'message') {
                return <Bubble mine={mine} author={author?.displayName ?? '?'} text={item.body} />;
              }
              return <LiveTurn turnId={item.id} author={author?.displayName ?? '?'} status={item.status} text={item.partialText} error={item.error} />;
            }}
          />
          <Composer
            roomId={id}
            participants={data.participants.filter(p => p.kind === 'harness')}
            onSent={() => {
              stickToBottom.current = true;
            }}
          />
        </KeyboardAvoidingView>
      </View>
    </>
  );
}

function Bubble({ mine, author, text }: { mine: boolean; author: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
      {!mine && <Muted style={styles.author}>{author}</Muted>}
      <View style={[styles.bubble, { backgroundColor: mine ? colors.primary : colors.card }]}>
        <Text selectable style={[styles.bubbleText, { color: mine ? 'white' : colors.text }]}>{text}</Text>
      </View>
    </View>
  );
}

function LiveTurn({ turnId, author, status, text, error }: { turnId: Id<'turns'>; author: string; status: string; text: string; error: string | null }) {
  const { colors } = useTheme();
  const active = status === 'queued' || status === 'running';
  const cancel = useMutation(api.messages.cancel);
  const [cancelError, setCancelError] = useState('');
  return (
    <View style={[styles.bubbleWrap, styles.left]}>
      <Muted style={styles.author}>
        {author} · {status === 'queued' ? 'waiting for the runner' : status === 'running' ? 'working' : status}
      </Muted>
      <View style={[styles.bubble, { backgroundColor: colors.card }]}>
        {text ? <Text selectable style={[styles.bubbleText, { color: colors.text }]}>{text}</Text> : null}
        {active && !text && <ActivityIndicator style={{ alignSelf: 'flex-start' }} />}
        {active && <Pressable accessibilityRole="button" onPress={() => { void cancel({ turnId }).catch(e => setCancelError(String(e))); }}><Text style={{ color: colors.primary }}>Cancel</Text></Pressable>}
        {cancelError ? <Text>{cancelError}</Text> : null}
        {error && <Text style={[styles.bubbleText, { color: '#d33' }]}>{error}</Text>}
      </View>
    </View>
  );
}

function Composer({ roomId, onSent, participants }: { roomId: Id<'rooms'>; onSent: () => void; participants: { _id: Id<'participants'>; displayName: string; harness?: string }[] }) {
  const send = useMutation(api.messages.send);
  const add = useMutation(api.rooms.addParticipant);
  const [selected, setSelected] = useState<Id<'participants'>>();
  const [error, setError] = useState('');
  const target = participants.find(p => p._id === selected) ?? participants[0];
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const keyboardOpen = useKeyboardOpen();

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      onSent();
      await send({ roomId, body, toParticipantId: target?._id });
      setText('');
      setError('');
    } catch (e) { setError(String(e)); } finally {
      setSending(false);
    }
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 16, padding: 12 }}>
        {participants.map(p => <Pressable key={p._id} onPress={() => setSelected(p._id)}><Body style={{ fontWeight: target?._id === p._id ? '700' : '400' }}>{p.displayName}</Body></Pressable>)}
        {(['claude', 'codex', 'pi'] as const).filter(h => !participants.some(p => p.harness === h)).map(h => <Pressable key={h} onPress={async () => { try { setSelected(await add({ roomId, harness: h })); setError(''); } catch (e) { setError(String(e)); } }}><Muted>+ {h}</Muted></Pressable>)}
      </View>
      {error ? <Body>{error}</Body> : null}
    <View style={[styles.composer, { borderTopColor: colors.border, paddingBottom: keyboardOpen ? 10 : Math.max(insets.bottom, 10) }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={`Message ${target?.displayName ?? "participant"}`}
        placeholderTextColor={PLACEHOLDER}
        multiline
        style={[styles.input, { color: colors.text, backgroundColor: colors.card }]}
      />
      <Pressable
        onPress={submit}
        disabled={!text.trim() || sending}
        style={({ pressed }) => [styles.send, { backgroundColor: colors.primary, opacity: !text.trim() || sending || pressed ? 0.4 : 1 }]}>
        <Text style={styles.sendLabel}>↑</Text>
      </Pressable>
    </View>
    </View>
  );
}

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

const PLACEHOLDER = '#8e8e93';

const styles = StyleSheet.create({
  list: { padding: 14, gap: 12 },
  empty: { textAlign: 'center', padding: 24 },
  bubbleWrap: { maxWidth: '88%', gap: 4 },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  author: { fontSize: 12, marginLeft: 4 },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, gap: 6 },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, fontSize: 16, maxHeight: 140, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderRadius: 20 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sendLabel: { color: 'white', fontSize: 20, fontWeight: '700' },
});
