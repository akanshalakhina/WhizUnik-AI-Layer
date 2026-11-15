import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('whizunik-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore local storage restrictions
  }
  // Default to clean enterprise light theme
  return 'light';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('whizunik-theme', theme);
  } catch {
    // ignore
  }
}

// Immediately apply theme before first paint
if (typeof window !== 'undefined') {
  applyTheme(getInitialTheme());
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = () => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      applyTheme(next);
      return next;
    });
  };

  return { theme, setTheme, toggle };
}
