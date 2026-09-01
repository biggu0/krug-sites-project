import {
  cleanPermissions,
  createSession,
  hashPassword,
  initializeAuth,
  sessionCookie,
  validCredentials
} from '../../_auth';
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>,
      {name, secret} = validCredentials(body.username, body.password),
      db = await initializeAuth(),
      count = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{count: number}>();
    if (Number(count?.count ?? 0) > 0)
      return Response.json({error: '系统已经完成初始化'}, {status: 409});
    const password = await hashPassword(secret),
      result = await db
        .prepare(
          'INSERT INTO users(username,password_hash,salt,permissions,active,created_at) VALUES(?,?,?,?,1,?)'
        )
        .bind(
          name,
          password.hash,
          password.salt,
          JSON.stringify(cleanPermissions(['customization', 'templates', 'accounts'])),
          Date.now()
        )
        .run(),
      session = await createSession(Number(result.meta.last_row_id));
    return Response.json({ok: true}, {headers: {'Set-Cookie': sessionCookie(session.token)}});
  } catch (error) {
    return Response.json(
      {error: error instanceof Error ? error.message : '初始化失败'},
      {status: 400}
    );
  }
}
