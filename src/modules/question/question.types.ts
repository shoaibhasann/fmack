export type CorrectOption    = 'a' | 'b' | 'c' | 'd';
export type Difficulty       = 'easy' | 'medium' | 'hard';
export type SubscriptionType = 'free' | 'premium' | 'pro';
export type QuestionType     = 'pyq' | 'practice' | 'mock' | 'concept';

export interface Question {
  id:                   string;
  stem:                 string;
  optionA:              string;
  optionB:              string;
  optionC:              string;
  optionD:              string;
  correctOption:        CorrectOption;
  questionImageUrl:     string | null;
  explanationText:      string | null;
  explanationImageUrls: string[];
  explanationTables:    Record<string, unknown> | null;
  subject:              string | null;
  topic:                string | null;
  subtopic:             string | null;
  difficulty:           Difficulty;
  tags:                 string[];
  isActive:             boolean;
  createdBy:            string;
  createdAt:            Date;
  updatedAt:            Date;
}

export type CreateQuestionData = Omit<Question, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateQuestionData = Partial<CreateQuestionData>;

export interface PaginatedResult<T> {
  data:   T[];
  total:  number;
  page:   number;
  pages:  number;
}

export interface QuestionFilters {
  subject?:    string;
  difficulty?: Difficulty;
  isActive?:   boolean;
  search?:     string;
}
