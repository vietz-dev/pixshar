import "./globals.css";
import { Toaster } from "sonner";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { EmotionRegistry } from "@/components/ui/emotion-registry";
import { Provider } from "@/components/ui/provider";

export const metadata = {
  title: "Pixshar",
  description: "Private event photo sharing",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Newsreader:ital,opsz,wght@0,12..72,300;0,12..72,400;0,12..72,500;1,12..72,300&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <EmotionRegistry>
          <Provider>
            <NextIntlClientProvider locale={locale} messages={messages}>
              {children}
              <Toaster position="bottom-right" richColors />
            </NextIntlClientProvider>
          </Provider>
        </EmotionRegistry>
      </body>
    </html>
  );
}
