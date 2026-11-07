import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { useColorScheme } from "react-native";

import { PushRouting } from "@/components/push-routing";

const publishableKey: string =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
const convexUrl: string = process.env.EXPO_PUBLIC_CONVEX_URL ?? "";

if (!publishableKey || !convexUrl) {
  throw new Error(
    "Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY and EXPO_PUBLIC_CONVEX_URL in apps/mobile/.env.local"
  );
}

const convex = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
});

const RootLayout = () => {
  const colorScheme = useColorScheme();
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {/* oxlint-disable-next-line react/hooks -- ConvexProviderWithClerk takes Clerk's useAuth hook as a prop and calls it itself. */}
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <PushRouting />
        <ThemeProvider
          value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
        >
          <Stack screenOptions={{ headerLargeTitle: true }}>
            <Stack.Screen name="index" options={{ title: "Atelier" }} />
            <Stack.Screen
              name="room/[id]"
              options={{ headerLargeTitle: false, title: "" }}
            />
          </Stack>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
};
export default RootLayout;
