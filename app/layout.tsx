import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JHT 图片处理',
  description: '批量挂历订单排版与 300 DPI PDF 导出系统。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
