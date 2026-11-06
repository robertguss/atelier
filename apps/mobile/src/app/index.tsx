import { PushReadiness } from '@/components/push-readiness';
import { api } from '@atelier/backend/api';
import { useAuth, useClerk } from '@clerk/expo';
import { useHostedAuth } from '@clerk/expo/hosted-auth';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { router, useTheme } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Body, Button, Centered, Field, Muted, Section, Title } from '@/components/ui';

export default function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();

  if (!isLoaded) return <Centered><ActivityIndicator /></Centered>;
  if (!isSignedIn) return <SignIn />;
  if (!isAuthenticated) return <Centered><ActivityIndicator /><Body>Connecting to Convex…</Body></Centered>;
  return <SignedIn />;
}

function SignIn() {
  const { startHostedAuth } = useHostedAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await startHostedAuth({ mode: 'sign-in' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Title>Atelier</Title>
      <Body>A room where you and your models work together.</Body>
      <Button label={busy ? 'Opening…' : 'Sign in'} onPress={signIn} disabled={busy} />
      {error && <Body style={{ color: '#d33' }}>{error}</Body>}
    </Centered>
  );
}

function SignedIn() {
  const { signOut } = useClerk();
  const me = useQuery(api.me.get);
  const isOwner = me?.signedIn === true && me.isOwner;

  if (me === undefined) return <Centered><ActivityIndicator /></Centered>;
  if (!isOwner) {
    return (
      <Centered>
        <Body>{me.signedIn ? `${me.email ?? 'This account'} is not the Atelier owner.` : 'Not signed in.'}</Body>
        <Button label="Sign out" onPress={() => signOut()} />
      </Centered>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
      <Rooms />
      <Runners />
      <PushReadiness />
      <Section title="You">
        <Body>{me.email ?? me.name}</Body>
        <Button label="Sign out" kind="secondary" onPress={() => signOut()} />
      </Section>
    </ScrollView>
  );
}

function Rooms() {
  const rooms = useQuery(api.rooms.list);
  const runners = useQuery(api.runners.list);
  const createRoom = useMutation(api.rooms.create);
  const { colors } = useTheme();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('/home/exedev/Projects/');

  const runner = runners?.[0];
  const submit = async () => {
    if (!runner || !name.trim() || !cwd.trim()) return;
    const roomId = await createRoom({ name, cwd, runnerId: runner._id });
    setCreating(false);
    setName('');
    router.push({ pathname: '/room/[id]', params: { id: roomId } });
  };

  return (
    <Section title="Rooms">
      {rooms === undefined && <ActivityIndicator />}
      {rooms?.length === 0 && !creating && <Muted>No rooms yet.</Muted>}
      {rooms?.map((room) => (
        <Pressable
          key={room._id}
          onPress={() => router.push({ pathname: '/room/[id]', params: { id: room._id } })}
          style={({ pressed }) => [styles.card, { backgroundColor: colors.card, opacity: pressed ? 0.6 : 1 }]}>
          <Body style={{ fontWeight: '600' }}>{room.name}{room.readyReviews ? ` · ${room.readyReviews} completed reviews` : ''}</Body>
          <Muted style={{ fontSize: 13 }}>{room.cwd}</Muted>
        </Pressable>
      ))}
      {creating ? (
        <View style={styles.form}>
          <Field placeholder="Room name" value={name} onChangeText={setName} autoCapitalize="words" />
          <Field placeholder="Project folder on the VM" value={cwd} onChangeText={setCwd} />
          <Muted style={{ fontSize: 13 }}>Runner: {runner?.name ?? 'none online'}</Muted>
          <View style={styles.row}>
            <View style={{ flex: 1 }}><Button label="Cancel" kind="secondary" onPress={() => setCreating(false)} /></View>
            <View style={{ flex: 1 }}><Button label="Create" onPress={submit} disabled={!runner || !name.trim()} /></View>
          </View>
        </View>
      ) : (
        <Button label="New room" kind="secondary" onPress={() => setCreating(true)} />
      )}
    </Section>
  );
}

function Runners() {
  const runners = useQuery(api.runners.list);
  const now = useNow(15_000);
  return (
    <Section title="Runners">
      {runners === undefined && <ActivityIndicator />}
      {runners?.length === 0 && <Muted>No runners have checked in yet.</Muted>}
      {runners?.map((r) => (
        <View key={r._id} style={{ gap: 2 }}>
          <Body style={{ fontWeight: '600' }}>
            {r.name} · {now - r.lastHeartbeatAt < 60_000 ? 'online' : 'offline'}
          </Body>
          <Muted style={{ fontSize: 14 }}>{r.harnesses.map((h) => `${h.id} ${h.version}`).join(' · ')}</Muted>
        </View>
      ))}
    </Section>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 28 },
  card: { padding: 14, borderRadius: 12, gap: 2 },
  form: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
});
