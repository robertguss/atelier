import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Stack, router, useLocalSearchParams, useTheme } from "expo-router";
import { useState, useRef } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";

import { Body, Button, Centered, Field, Muted, Section } from "@/components/ui";

export default function Ritual() {
  const { id } = useLocalSearchParams<{ id: Id<"rituals"> }>();
  const review = useQuery(api.rituals.get, { ritualId: id });
  const saveTakeaway = useMutation(api.rituals.saveTakeaway);
  const cancel = useMutation(api.messages.cancel);
  const [takeaway, setTakeaway] = useState("");
  const [addingTakeaway, setAddingTakeaway] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const container = useRef<React.ComponentRef<typeof View>>(null);
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  async function save(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (review === undefined)
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  if (!review)
    return (
      <Centered>
        <Body>Review not found.</Body>
      </Centered>
    );
  const finished = review.turns.filter(
    (t) => !["queued", "running"].includes(t.status)
  ).length;
  return (
    <View
      ref={container}
      style={{ flex: 1 }}
      onLayout={() =>
        container.current?.measureInWindow((_x: number, y: number) =>
          setOffset(y)
        )
      }
    >
      <Stack.Screen
        options={{ title: "Independent review", headerLargeTitle: false }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={offset}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 20 }}
        >
          <Body>{review.request}</Body>
          <Body>
            {finished}/{review.turns.length} finished ·{" "}
            {review.status === "collecting" ? "Collecting" : "Complete"}
          </Body>
          {review.status !== "collecting" &&
            (addingTakeaway ? (
              <Section title="Save a takeaway (optional)">
                <Field
                  placeholder="Anything you want to remember?"
                  accessibilityLabel="Takeaway"
                  value={takeaway}
                  onChangeText={setTakeaway}
                  multiline
                />
                <Button
                  label="Save takeaway"
                  disabled={busy || !takeaway.trim()}
                  onPress={() =>
                    void save(async () => {
                      await saveTakeaway({ ritualId: id, body: takeaway });
                      setTakeaway("");
                      setAddingTakeaway(false);
                    })
                  }
                />
                <Button
                  label="Cancel"
                  kind="secondary"
                  onPress={() => setAddingTakeaway(false)}
                />
              </Section>
            ) : (
              <Button
                label="Save a takeaway (optional)"
                kind="secondary"
                onPress={() => setAddingTakeaway(true)}
              />
            ))}
          {review.status === "collecting" ? (
            <>
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{
                  min: 0,
                  max: review.turns.length,
                  now: finished,
                }}
                style={{ height: 6, backgroundColor: colors.border }}
              >
                <View
                  style={{
                    height: 6,
                    width: `${(100 * finished) / Math.max(1, review.turns.length)}%`,
                    backgroundColor: colors.primary,
                  }}
                />
              </View>
              <Muted>
                Answers stay sealed until every participant finishes or fails.
                You can close the app.
              </Muted>
              {review.turns.map((t) => (
                <View key={t._id} style={{ gap: 4 }}>
                  <Body>
                    {t.name} · {t.status}
                  </Body>
                  {["queued", "running"].includes(t.status) && (
                    <Button
                      label={`Cancel ${t.name}`}
                      kind="secondary"
                      disabled={busy}
                      onPress={() => void save(() => cancel({ turnId: t._id }))}
                    />
                  )}
                </View>
              ))}
            </>
          ) : (
            <>
              <Muted>Swipe to compare answers.</Muted>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator
              >
                {review.turns.map((t) => (
                  <View
                    key={t._id}
                    style={{
                      width: width - 32,
                      padding: 12,
                      gap: 12,
                      backgroundColor: colors.card,
                    }}
                  >
                    <Body style={{ fontWeight: "700" }}>
                      {t.name} · {t.status}
                    </Body>
                    <Button
                      label={`Follow up with ${t.name}`}
                      onPress={() =>
                        router.push({
                          pathname: "/room/[id]",
                          params: {
                            id: review.roomId,
                            participantId: t.participantId,
                            reviewTurnId: t._id,
                          },
                        })
                      }
                    />
                    <Body selectable>
                      {t.answer ?? t.error ?? "No answer returned."}
                    </Body>
                  </View>
                ))}
              </ScrollView>
            </>
          )}
          {review.cruxes.map((c) => (
            <Section key={c._id} title="Saved note">
              <Body>{c.statement}</Body>
              {c.options.map((option, n) => (
                <Muted key={n}>{option}</Muted>
              ))}
            </Section>
          ))}
          {review.decisions.map((d) => (
            <Section key={d._id} title="Saved decision">
              <Body>{d.choice}</Body>
              <Muted>{d.rationale}</Muted>
              <Button
                label="Continue in the room"
                onPress={() =>
                  router.push({
                    pathname: "/room/[id]",
                    params: { id: review.roomId, decisionId: d._id },
                  })
                }
              />
            </Section>
          ))}
          {review.takeaways.map((note) => (
            <Section key={note._id} title="Takeaway">
              <Body>{note.body}</Body>
            </Section>
          ))}
          {error ? <Body style={{ color: "#d33" }}>{error}</Body> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
