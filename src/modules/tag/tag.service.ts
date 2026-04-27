import * as repo from './tag.repository';

export async function listTags(): Promise<string[]> {
  return repo.findAllTags();
}
