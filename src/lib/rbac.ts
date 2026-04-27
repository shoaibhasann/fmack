export const ROLES = {
  ADMIN:  'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = {
  QUESTIONS_CREATE: 'questions:create',
  QUESTIONS_EDIT:   'questions:edit',
  QUESTIONS_DELETE: 'questions:delete',
  QUESTIONS_VIEW:   'questions:view',
  EXAMS_MANAGE:     'exams:manage',
  SUBJECTS_MANAGE:  'subjects:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.ADMIN]:  Object.values(PERMISSIONS) as Permission[],
  [ROLES.EDITOR]: [
    PERMISSIONS.QUESTIONS_CREATE,
    PERMISSIONS.QUESTIONS_EDIT,
    PERMISSIONS.QUESTIONS_VIEW,
  ],
  [ROLES.VIEWER]: [PERMISSIONS.QUESTIONS_VIEW],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
