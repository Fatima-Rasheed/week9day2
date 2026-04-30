import { useEffect, useState } from 'react';
import ChatInterface from '@/components/ChatInterface';
import styles from '@/styles/Home.module.css';
import { useTheme } from '@/context/ThemeContext';

export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Before mount, render theme-neutral placeholders so SSR and first client
  // render produce identical HTML — no hydration mismatch.
  const themeLabel = mounted ? `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode` : 'Toggle theme';
  const themeIcon  = mounted ? (theme === 'dark' ? '☀️' : '🌙') : '☀️';

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <span className={styles.headerIcon}>🏏</span>
          <div className={styles.headerText}>
            <h1>Cricket Stats AI</h1>
            <p>Your intelligent cricket statistics assistant</p>
          </div>
          <div className={styles.badgeRow}>
            <span className={`${styles.badge} ${styles.primary}`}>⚡ Live AI</span>
            <span className={styles.badge}>📊 Deep Stats</span>
            <button
              className={styles.themeToggle}
              onClick={toggleTheme}
              title={themeLabel}
              aria-label={themeLabel}
              suppressHydrationWarning
            >
              {themeIcon}
            </button>
          </div>
        </div>
      </header>
      <ChatInterface />
    </div>
  );
}