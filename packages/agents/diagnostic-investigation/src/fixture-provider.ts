import type { ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';

export class FixtureModelProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly defaultModel = 'fixture-model';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;
  }
}
