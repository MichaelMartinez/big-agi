import { DLLMId } from '~/modules/llms/llm.types';
import { LLMOptionsOpenAI, SourceSetupOpenAI } from '~/modules/llms/openai/vendor';
import { OpenAI } from '~/modules/openai/openai.types';
import { SystemPurposeId } from '../../../data';
import { autoTitle } from '~/modules/aifn/autotitle/autoTitle';
import { findLLMOrThrow, findOpenAILlmRefOrThrow } from '~/modules/llms/store-llms';
import { speakText } from '~/modules/elevenlabs/elevenlabs.client';
import { useElevenlabsStore } from '~/modules/elevenlabs/store-elevenlabs';

import { DMessage, useChatStore } from '~/common/state/store-chats';

import { createAssistantTypingMessage, updatePurposeInHistory } from './editors';


/**
 * The main "chat" function. TODO: this is here so we can soon move it to the data model.
 */
export async function runAssistantUpdatingState(conversationId: string, history: DMessage[], assistantLlmId: DLLMId, systemPurpose: SystemPurposeId) {

  // update the system message from the active Purpose, if not manually edited
  history = updatePurposeInHistory(conversationId, history, systemPurpose);

  // create a blank and 'typing' message for the assistant
  const assistantMessageId = createAssistantTypingMessage(conversationId, assistantLlmId, history[0].purposeId, '...');

  // when an abort controller is set, the UI switches to the "stop" mode
  const controller = new AbortController();
  const { startTyping, editMessage } = useChatStore.getState();
  startTyping(conversationId, controller);

  await streamAssistantMessage(conversationId, assistantMessageId, history, assistantLlmId, editMessage, controller.signal);

  // clear to send, again
  startTyping(conversationId, null);

  // update text, if needed
  await autoTitle(conversationId);
}


const getOpenAISettings = ({ oaiKey, oaiOrg, oaiHost, heliKey }: Partial<SourceSetupOpenAI>): Partial<OpenAI.API.Configuration> => {
  return {
    ...(oaiHost ? { apiHost: oaiHost } : {}),
    ...(oaiKey ? { apiKey: oaiKey } : {}),
    ...(oaiOrg ? { apiOrganizationId: oaiOrg } : {}),
    ...(heliKey ? { heliconeKey: heliKey } : {}),
  };
};

async function streamAssistantMessage(
  conversationId: string, assistantMessageId: string, history: DMessage[],
  llmId: DLLMId,
  editMessage: (conversationId: string, messageId: string, updatedMessage: Partial<DMessage>, touch: boolean) => void,
  abortSignal: AbortSignal,
) {

  // access params
  const llm = findLLMOrThrow(llmId);
  const oaiSetup: Partial<SourceSetupOpenAI> = llm._source.setup as Partial<SourceSetupOpenAI>;
  const apiAccess: Partial<OpenAI.API.Configuration> = getOpenAISettings(oaiSetup);

  const { llmRef, llmTemperature, llmResponseTokens }: Partial<LLMOptionsOpenAI> = llm.options || {};
  if (!llmRef || llmTemperature === undefined || llmResponseTokens === undefined)
    throw new Error(`Error in openAI configuration for model ${llmId}`);

  const openAILlmId = findOpenAILlmRefOrThrow(llmId);
  const { elevenLabsAutoSpeak } = useElevenlabsStore.getState();
  const payload: OpenAI.API.Chat.Request = {
    api: apiAccess,
    model: openAILlmId,
    messages: history.map(({ role, text }) => ({
      role: role,
      content: text,
    })),
    temperature: llmTemperature,
    max_tokens: llmResponseTokens,
  };

  try {

    const response = await fetch('/api/openai/stream-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // loop forever until the read is done, or the abort controller is triggered
      let incrementalText = '';
      let parsedFirstPacket = false;
      let sentFirstParagraph = false;
      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        incrementalText += decoder.decode(value, { stream: true });

        // there may be a JSON object at the beginning of the message, which contains the model name (streaming workaround)
        if (!parsedFirstPacket && incrementalText.startsWith('{')) {
          const endOfJson = incrementalText.indexOf('}');
          if (endOfJson > 0) {
            const json = incrementalText.substring(0, endOfJson + 1);
            incrementalText = incrementalText.substring(endOfJson + 1);
            try {
              const parsed: OpenAI.API.Chat.StreamingFirstResponse = JSON.parse(json);
              editMessage(conversationId, assistantMessageId, { originLLM: parsed.model }, false);
              parsedFirstPacket = true;
            } catch (e) {
              // error parsing JSON, ignore
              console.log('Error parsing JSON: ' + e);
            }
          }
        }

        // if the first paragraph (after the first packet) is complete, call the callback
        if (parsedFirstPacket && elevenLabsAutoSpeak === 'firstLine' && !sentFirstParagraph) {
          let cutPoint = incrementalText.lastIndexOf('\n');
          if (cutPoint < 0)
            cutPoint = incrementalText.lastIndexOf('. ');
          if (cutPoint > 100 && cutPoint < 400) {
            sentFirstParagraph = true;
            const firstParagraph = incrementalText.substring(0, cutPoint);
            speakText(firstParagraph).then(() => false /* fire and forget, we don't want to stall this loop */);
          }
        }

        editMessage(conversationId, assistantMessageId, { text: incrementalText }, false);
      }
    }

  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // expected, the user clicked the "stop" button
    } else {
      // TODO: show an error to the UI
      console.error('Fetch request error:', error);
    }
  }

  // finally, stop the typing animation
  editMessage(conversationId, assistantMessageId, { typing: false }, false);
}