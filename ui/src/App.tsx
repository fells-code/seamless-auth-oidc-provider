/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { AuthProvider } from '@seamless-auth/react';
import { AuthRoutes } from '@seamless-auth/react/routes';
import { Route, Routes } from 'react-router-dom';

import { readHostedConfig } from './hostedConfig';
import { InteractionPage } from './InteractionPage';
import { Layout } from './Layout';
import { Resume } from './Resume';

export function App() {
  const { appName, logoUrl } = readHostedConfig();
  const origin = window.location.origin;
  return (
    <AuthProvider apiHost={origin} magicLinkRedirectUri={`${origin}/verify-magiclink`}>
      <Layout appName={appName} logoUrl={logoUrl}>
        <Routes>
          <Route path="/" element={<Resume />} />
          <Route path="/interaction/:uid" element={<InteractionPage appName={appName} />} />
          <Route path="/*" element={<AuthRoutes />} />
        </Routes>
      </Layout>
    </AuthProvider>
  );
}
