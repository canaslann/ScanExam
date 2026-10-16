"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="scanexam-theme" disableTransitionOnChange>{children}</ThemeProvider>;
}

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const themes = [
  { value: "light", label: "Açık", Icon: Sun },
  { value: "dark", label: "Koyu", Icon: Moon },
  { value: "system", label: "Sistem", Icon: Monitor },
] as const;

export function ThemeControls() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return (
    <div className="theme-controls" role="group" aria-label="Görünüm teması">
      {themes.map(({ value, label, Icon }) => (
        <button key={value} type="button" title={`${label} tema`} aria-label={`${label} tema`}
          aria-pressed={mounted && theme === value} onClick={() => setTheme(value)}>
          <Icon className="size-4" /><span>{label}</span>
        </button>
      ))}
    </div>
  );
}
