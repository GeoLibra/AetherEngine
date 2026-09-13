import { useEffect, useState } from 'react';
import { DEMO_REGISTRY, resolveDemo } from './demos/registry';
import type { DemoDefinition } from './demos/types';

export function App({ mountScene = true }: Readonly<{ mountScene?: boolean }>) {
  const [activePath, setActivePath] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );

  useEffect(() => {
    const handlePopState = () => {
      setActivePath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const navigateTo = (path: string) => {
    if (typeof window !== 'undefined' && window.location.pathname !== path) {
      window.history.pushState(null, '', `${path}${window.location.search}${window.location.hash}`);
      setActivePath(path);
    }
  };

  const currentDemo: DemoDefinition = resolveDemo(activePath);
  const ActiveComponent = currentDemo.component;

  const isE2E =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e');

  return (
    <main className="app-container">
      {!isE2E && (
        <header className="demo-header" role="banner">
          <div className="header-brand">
            <h1 className="header-title">Aether Engine</h1>
            <span className="header-tag">Demo Showcase</span>
          </div>
          <nav className="demo-nav" aria-label="Demo selection">
            {DEMO_REGISTRY.map((demo) => {
              const isActive = demo.id === currentDemo.id;
              return (
                <button
                  key={demo.id}
                  type="button"
                  className={`nav-tab ${isActive ? 'active' : ''}`}
                  onClick={() => navigateTo(demo.path)}
                  title={demo.description}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="tab-title">{demo.title}</span>
                  <span className="tab-subtitle">{demo.subtitle}</span>
                </button>
              );
            })}
          </nav>
        </header>
      )}
      <div className="demo-viewport">
        <ActiveComponent key={currentDemo.id} mountScene={mountScene} />
      </div>
    </main>
  );
}
