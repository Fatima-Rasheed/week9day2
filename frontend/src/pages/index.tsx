import ChatInterface from '@/components/ChatInterface';
import styles from '@/styles/Home.module.css';
import { useTheme } from '@/context/ThemeContext';

export default function Home() {
  const { theme, toggleTheme } = useTheme();

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
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
      </header>
      <ChatInterface />
    </div>
  );
}
