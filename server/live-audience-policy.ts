export interface LiveAudience {
  all: boolean;
  owners: boolean;
  userIds: string[];
}

export interface LiveClientIdentity {
  userId: string;
  role: 'owner' | 'entry';
}

export function audienceAllows(audience: LiveAudience, client: LiveClientIdentity): boolean {
  return audience.all || (audience.owners && client.role === 'owner') || audience.userIds.includes(client.userId);
}
