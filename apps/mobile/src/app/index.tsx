import { api } from '@atelier/backend/api';
import { useAuth, useClerk } from '@clerk/expo';
import { useHostedAuth } from '@clerk/expo/hosted-auth';
import { useTheme } from 'expo-router';
import { useConvexAuth, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// Step 1 screen: proves Clerk sign-in → Convex auth → live query works on the
// phone, and shows the runners that have checked in.
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
  const isOwner = me?.signedIn && me.isOwner;
  const runners = useQuery(api.runners.list, isOwner ? {} : 'skip');
  const now = useNow(15_000);

  if (me === undefined) return <Centered><ActivityIndicator /></Centered>;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
      <Section title="You">
        <Body>{me.signedIn ? (me.email ?? me.name ?? 'Signed in') : 'Not signed in'}</Body>
        {me.signedIn && !me.isOwner && (
          <Body style={{ color: '#d33' }}>This account is not the Atelier owner.</Body>
        )}
      </Section>
      {isOwner && (
        <Section title="Runners">
          {runners === undefined && <ActivityIndicator />}
          {runners?.length === 0 && <Body>No runners have checked in yet.</Body>}
          {runners?.map((r) => (
            <View key={r._id} style={styles.row}>
              <Body style={styles.bold}>
                {r.name} · {now - r.lastHeartbeatAt < 60_000 ? 'online' : 'offline'}
              </Body>
              {r.harnesses.map((h) => (
                <Body key={h.id}>{h.id}: {h.version}</Body>
              ))}
            </View>
          ))}
        </Section>
      )}
      <Button label="Sign out" onPress={() => signOut()} />
    </ScrollView>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: useTheme().colors.text }]}>{title}</Text>
      {children}
    </View>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

function Title({ children }: { children: React.ReactNode }) {
  return <Text style={[styles.title, { color: useTheme().colors.text }]}>{children}</Text>;
}

function Body({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.body, { color: useTheme().colors.text }, style]}>{children}</Text>;
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: colors.primary, opacity: pressed || disabled ? 0.6 : 1 }]}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  scroll: { padding: 20, gap: 24 },
  title: { fontSize: 34, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  bold: { fontWeight: '600' },
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', opacity: 0.6 },
  row: { gap: 2, paddingVertical: 4 },
  button: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  buttonLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
});
